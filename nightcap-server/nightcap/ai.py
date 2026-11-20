"""Calling the household's AI with its own key, what each call costs, and the household's monthly limit.

The household picks whose AI (PROVIDERS), the model and the key in Settings. Anthropic's is asked through
its own library; OpenAI, OpenRouter and any address that answers like OpenAI ("other": a service of the
household's own) through OpenAI's library. Each answer is checked against the shape asked for (the
models don't always keep to it), and asked once more if it isn't; whatever goes wrong, the caller gets
AIUnavailable and goes on without the AI.

The limit is checked before each call against what this month's calls have cost plus the most this
call could cost (its prompt, and all of the output it may write), so a call never takes the month over
the limit. What a call costs: what OpenRouter says it cost, else the model's price (ai.prices for
Anthropic's and OpenAI's own models, else the household's own; [0, 0] when it said "free"). A model without a known price is still asked: its calls' tokens are counted, their cost
is unknown (NULL), and the monthly limit isn't applied to it (it couldn't be kept).
"""

import json
import logging
import re
import uuid
from collections import namedtuple
from contextvars import ContextVar

import anthropic
import openai

from . import accounts, store
from .config import MODEL, PRICES, S
from .context import me
from .http import checked_http_client

log = logging.getLogger(__name__)

# The AI libraries log each request with its address (a household's own may be its secret).
for _name in ("httpx", "httpx2"):
    logging.getLogger(_name).setLevel(logging.WARNING)

PROVIDERS = {
    "anthropic": "Claude (Anthropic)",
    "openai": "OpenAI",
    "openrouter": "OpenRouter",
    "other": "Other (OpenAI-compatible address)",
}
OPENROUTER_URL = "https://openrouter.ai/api/v1"
# The price of these is never taken from ai.prices: an address of the household's own may call any model
# by any name, and OpenRouter's ids are its own ("openai/gpt-5-mini").
BUILT_IN_PRICES = ("anthropic", "openai")


# What a service answers when the key or model won't do until it's changed (not worth asking again).
REJECTED = (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.NotFoundError,
            openai.AuthenticationError, openai.PermissionDeniedError, openai.NotFoundError)


class AIUnavailable(Exception):
    """No AI for this household right now: [reason] is "no_key", "no_model" (a key, but no model chosen
    yet: it must be chosen in Settings), "limit", "rejected" (the service refused the key, or has no
    such model: until it's changed in Settings) or "failed" (the AI didn't answer, or not in the shape
    asked for: this time only, it may answer the next)."""

    WORDS = {"no_key": "The household has no AI key",
             "no_model": "The household's AI model isn't chosen: choose it in Settings",
             "limit": "The household's monthly AI limit is reached",
             "rejected": "The AI service refused the household's key or model: change it in Settings",
             "failed": "The AI didn't give a usable answer"}

    def __init__(self, reason):
        super().__init__(self.WORDS[reason])
        self.reason = reason


# ---------- The household's AI ----------

def settings(account=None):
    """{"provider", "key", "model", "base_url", "price"} as saved (see store.secrets)."""
    s = store.secrets(account or accounts.account_id())
    return {"provider": s["ai_provider"], "key": s["ai_api_key"], "model": s["ai_model"],
            "base_url": s["ai_base_url"], "price": s["ai_price"]}


def price_of(ai):
    """(input, output) US dollars per million tokens, or None: ai.prices for Anthropic's and OpenAI's
    own models, else the household's own."""
    if ai["provider"] in BUILT_IN_PRICES and ai["model"] in PRICES:
        return PRICES[ai["model"]]
    return tuple(ai["price"]) if ai.get("price") is not None else None


def available():
    """Whether this household has the AI: it's optional, and without a key nothing about it is shown."""
    ai = settings()
    return bool(ai["key"] and ai["model"])


def usable():
    """Whether an AI call would be allowed now (a key, a model, under the monthly limit): what decides
    if Smart Search is offered."""
    try:
        check_allowed()
        return True
    except AIUnavailable:
        return False


def check_allowed(prompt_chars=0, max_tokens=0):
    """The household's AI and its price (None when it isn't known), if a call with a prompt of
    [prompt_chars] that may write [max_tokens] is allowed: raises AIUnavailable when there's no key or
    model, or the call could take this month's spend over the limit (a model without a price isn't held
    to the limit)."""
    ai = settings()
    if not ai["key"]:
        raise AIUnavailable("no_key")
    if not ai["model"]:
        raise AIUnavailable("no_model")
    price = price_of(ai)
    limit = accounts.monthly_limit()
    if limit is not None and price is not None:
        spend = store.month_spend(accounts.account_id(), accounts.timezone())
        # (About 4 characters a token.)
        most = prompt_chars / 4 / 1e6 * price[0] + max_tokens / 1e6 * price[1]
        if spend >= limit or spend + most > limit:
            raise AIUnavailable("limit")
    return ai, price


# ---------- What it costs ----------

def record_usage(purpose, ai, price, usage, profile=None):
    """One AI call and its cost, charged to the profile it was for ([profile], else the current one). Its
    cost is None when neither the service said it nor the model's price is known."""
    cost = usage.cost
    if cost is None and price is not None:
        cost = usage.input / 1e6 * price[0] + usage.output / 1e6 * price[1]
    try:
        store.record_usage(profile or me(), purpose, ai["model"], usage.input, usage.output,
                           round(cost, 6) if cost is not None else None)
    except Exception:
        log.exception("Couldn't record AI usage")


def usage_summary():
    """This month's spend (see store.usage_summary), with the limit and whether it's reached. [priced]:
    whether the household's model has a known price; false, its calls' cost is unknown (counted in
    month_unpriced_calls, not in the costs) and the limit isn't applied to it, so it's never reached."""
    out = store.usage_summary(accounts.account_id(), accounts.timezone())
    limit = accounts.monthly_limit()
    ai = settings()
    priced = price_of(ai) is not None if ai["model"] else True
    return {**out, "limit": limit, "priced": priced,
            "limitReached": priced and limit is not None and out["month_cost"] >= limit}


# ---------- Checking an answer's shape ----------

def schema_problem(value, schema, where="answer"):
    """What's wrong with [value] for [schema] (the JSON schema kinds Nightcap's prompts use: object,
    array, string, integer, number, boolean, enum), or None."""
    kind = schema.get("type")
    if "enum" in schema and value not in schema["enum"]:
        return f"{where} isn't one of {schema['enum']}"
    if kind == "object":
        if not isinstance(value, dict):
            return f"{where} isn't an object"
        props = schema.get("properties") or {}
        for name in schema.get("required") or []:
            if name not in value:
                return f"{where} has no {name}"
        if schema.get("additionalProperties") is False and (extra := set(value) - set(props)):
            return f"{where} has {sorted(extra)[0]}, not asked for"
        for name, sub in props.items():
            if name in value and (problem := schema_problem(value[name], sub, f"{where}.{name}")):
                return problem
        return None
    if kind == "array":
        if not isinstance(value, list):
            return f"{where} isn't a list"
        items = schema.get("items")
        for i, v in enumerate(value):
            if items and (problem := schema_problem(v, items, f"{where}[{i}]")):
                return problem
        return None
    checks = {"string": lambda v: isinstance(v, str), "boolean": lambda v: isinstance(v, bool),
              "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
              "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)}
    if kind in checks and not checks[kind](value):
        return f"{where} isn't a {kind}"
    return None


def _parse(text):
    """The JSON in a model's answer (one asked for JSON without a schema may wrap it in ``` fences)."""
    text = (text or "").strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.S)
    return json.loads(fenced.group(1) if fenced else text)


# ---------- Asking ----------

# The model that gave this context's last answer (ask_ai), for save_picks.
_answered_by = ContextVar("answered_by", default=None)


def save_picks(feature, sent, picks, seed=None, query=None):
    """Saves an AI answer that's being used (the ai_picks table), as the AI gave it: [sent], the
    candidates' keys it was given, in that order; [picks], its picks, keys only, in its own order,
    before anything is sorted, filtered or taken out (for Home: {"for_you": [keys], "because": [{"seed",
    "row", "picks"}], "themes": [{"title", "row", "picks"}], …} as its answer has them; "row" is the
    Home row it became, or null when none did). Returns the new request id, to go out with the rows it
    makes; None if it couldn't be saved (the rows are shown all the same). Home's rows as the apps
    name them: for_you is "foryou", shows "tv:foryou", movies "movie:foryou"; a Because row "because0"
    is "tv:because0" or "movie:because0" on the Shows and Movies pages too."""
    request_id = uuid.uuid4().hex
    try:
        store.save_ai_picks(me(), request_id, feature, _answered_by.get(), sent, picks, seed, query)
        return request_id
    except Exception:
        log.exception("Couldn't save the AI's picks (%s)", feature)
        return None


# One call's tokens, and its cost when the service said it (OpenRouter does).
Usage = namedtuple("Usage", "input output cost")
# One call's answer: its text, its usage (None if the service gave none), and "refusal" or "max_tokens"
# when it stopped for that.
Answer = namedtuple("Answer", "text usage stop")


def ask_ai(system, prompt, schema, effort="medium", max_tokens=S.ai.max_tokens.rebuild, purpose="rebuild", think=True):
    """The AI's answer to [prompt], in the shape of [schema] (a JSON schema, every property required,
    no others). [think]: False turns the model's thinking down as far as it goes (it's paid output,
    often most of a call's cost). An answer that isn't JSON
    in that shape is asked for once more; one the model refused, or cut short at [max_tokens], isn't
    (it would be the same again). Raises AIUnavailable, whatever went wrong."""
    for attempt in range(2):
        ai, price = check_allowed(len(system) + len(prompt), max_tokens)
        try:
            answer = _ask(ai, system, prompt, schema, effort, max_tokens, think, plain=attempt > 0)
        except Exception as e:
            log.warning("AI call (%s) failed: %s", purpose, _why(e))
            # (OpenRouter's 403 is also a prompt its moderation flagged: this time only.)
            lasting = isinstance(e, REJECTED) and not (ai["provider"] == "openrouter" and isinstance(e, openai.PermissionDeniedError))
            raise AIUnavailable("rejected" if lasting else "failed") from e
        usage = answer.usage or _guessed(system + prompt, answer.text)
        log.info("AI usage (%s): %s in, %s out", purpose, usage.input, usage.output)
        # (Paid for whether or not the answer is any use.)
        record_usage(purpose, ai, price, usage)
        if answer.stop:
            log.warning("AI call (%s): the model stopped (%s)", purpose, answer.stop)
            break
        try:
            found = _parse(answer.text)
            problem = schema_problem(found, schema)
        except ValueError:
            problem = "not JSON"
        if not problem:
            _answered_by.set(ai["model"])
            return found
        log.warning("AI call (%s): the answer wasn't in the shape asked for (%s)", purpose, problem)
    raise AIUnavailable("failed")


def _guessed(prompt, text):
    """A service that doesn't say how many tokens a call took: about 4 characters a token."""
    return Usage(len(prompt) // 4, len(text or "") // 4, None)


def _ask(ai, system, prompt, schema, effort, max_tokens, think, plain=False, timeout=None):
    if ai["provider"] == "anthropic":
        return _anthropic(ai, system, prompt, schema, effort, max_tokens, think, timeout)
    return _openai(ai, system, prompt, schema, effort, max_tokens, think, plain, timeout)


def _why(e):
    """A failed call, for the logs: never an address (an "other" one is the household's secret)."""
    if isinstance(e, (anthropic.APIStatusError, openai.APIStatusError)):
        return f"{type(e).__name__} ({e.status_code})"
    return type(e).__name__


# ---------- Anthropic ----------

# Models whose refusals can go to another model on Anthropic's side (server-side fallbacks).
FALLBACK_MODELS = ("claude-fable-5-1", "claude-opus-5", "claude-sonnet-5-5")
# Models whose thinking can't be turned off (effort is the only control), and the ones that turn it
# off their own way.
ALWAYS_THINKING = ("claude-fable", "claude-mythos", "claude-opus-5-5")
THINKING_OFF = {"claude-sonnet-5-5": {"type": "between_tools"}}
# Older models that refuse an effort.
NO_EFFORT = ("claude-3", "claude-haiku-4", "claude-sonnet-4-5", "claude-opus-4-1", "claude-sonnet-4-2", "claude-opus-4-2")


def _anthropic(ai, system, prompt, schema, effort, max_tokens, think, timeout=None):
    model = ai["model"]
    client = anthropic.Anthropic(api_key=ai["key"], **({"timeout": timeout, "max_retries": 0} if timeout else {}))
    kwargs = {}
    if not think and not model.startswith(ALWAYS_THINKING):
        kwargs["thinking"] = next((v for k, v in THINKING_OFF.items() if model.startswith(k)), {"type": "disabled"})
    if model.startswith(FALLBACK_MODELS):
        kwargs |= {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    output = {"format": {"type": "json_schema", "schema": schema}}
    if not model.startswith(NO_EFFORT):
        output["effort"] = effort
    with client.beta.messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=system,
        output_config=output,
        messages=[{"role": "user", "content": prompt}],
        **kwargs,
    ) as stream:
        response = stream.get_final_message()
    if response.stop_reason == "refusal":
        log.warning("Claude declined the request: %s", response.stop_details)
    text = next((b.text for b in response.content if b.type == "text"), None)
    u = response.usage
    return Answer(text, Usage(u.input_tokens, u.output_tokens, None),
                  response.stop_reason if response.stop_reason in ("refusal", "max_tokens") else None)


# ---------- OpenAI, OpenRouter, and any address that answers like OpenAI ----------

# Models that reason before answering, and so take an effort (any other refuses one): OpenAI's o-series
# and GPT-5 (not its "chat" ones), by their own id or OpenRouter's ("openai/…").
REASONING = re.compile(r"^(openai/)?(o\d|gpt-5)(?!.*chat)")
# Models (by provider, address and id) that turned out not to take a JSON schema: asked for JSON with
# the schema in the prompt instead, from then on.
_PLAIN = set()


def _openai_client(ai, timeout=None):
    kwargs = {"api_key": ai["key"]}
    if ai["provider"] == "openrouter":
        kwargs["base_url"] = OPENROUTER_URL
    elif ai["provider"] == "other":
        # (The household's own address: reached only through the checked connections, see http.py.)
        # (Asked once more at most if it doesn't answer, not the library's three times: a play's
        # Smart Search or More like this waits for it.)
        kwargs |= {"base_url": ai["base_url"], "http_client": checked_http_client(), "max_retries": 1}
    if timeout:
        kwargs |= {"timeout": timeout, "max_retries": 0}
    return openai.OpenAI(**kwargs)


def _openai(ai, system, prompt, schema, effort, max_tokens, think, plain=False, timeout=None):
    """Chat Completions, with a strict JSON schema; a model that refuses one (a 400, or OpenRouter
    finding no provider that takes it) is asked again at once for JSON with the schema in the prompt,
    as is one whose answer didn't keep to the shape ([plain]: the second try)."""
    model = ai["model"]
    which = (ai["provider"], ai.get("base_url"), model)
    client = _openai_client(ai, timeout)
    reasoning = bool(REASONING.match(model))
    kwargs = {"model": model,
              # (A reasoning model's thinking is counted in what it writes; the others stop at most_output_plain.)
              "max_completion_tokens": max_tokens if reasoning else min(max_tokens, S.ai.most_output_plain)}
    extra = {}
    if reasoning:
        level = effort if think else "low"
        if ai["provider"] == "openrouter":
            extra["reasoning"] = {"effort": level}
        else:
            kwargs["reasoning_effort"] = level
    if ai["provider"] == "openrouter":
        # Only providers that take every parameter sent (the schema above all), and none that keep
        # what's sent to train on.
        extra["provider"] = {"require_parameters": True, "data_collection": "deny"}
    if extra:
        kwargs["extra_body"] = extra

    def create(as_plain):
        if as_plain:
            # (The word "JSON" must be in the messages for this mode.)
            messages = [{"role": "system", "content": f"{system}\n\nAnswer with JSON only, nothing else, "
                                                      f"matching this JSON schema:\n{json.dumps(schema)}"},
                        {"role": "user", "content": prompt}]
            return client.chat.completions.create(messages=messages, response_format={"type": "json_object"}, **kwargs)
        return client.chat.completions.create(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            response_format={"type": "json_schema", "json_schema": {"name": "answer", "schema": schema, "strict": True}},
            **kwargs)

    as_plain = plain or which in _PLAIN
    try:
        response = create(as_plain)
    except (openai.BadRequestError, openai.NotFoundError, openai.UnprocessableEntityError):
        if as_plain:
            raise
        log.info("The AI model didn't take a JSON schema: asking for JSON instead")
        _PLAIN.add(which)
        response = create(True)
    u = response.usage
    # (What it cost, as OpenRouter says, and only OpenRouter: another address's "cost" isn't trusted.)
    cost = (u.model_extra or {}).get("cost") if u and ai["provider"] == "openrouter" else None
    if not (isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0):
        cost = None
    usage = Usage(u.prompt_tokens, u.completion_tokens, cost) if u else None
    choice = response.choices[0] if response.choices else None
    if choice is None:
        return Answer(None, usage, None)
    stop = ("refusal" if choice.message.refusal or choice.finish_reason == "content_filter"
            else "max_tokens" if choice.finish_reason == "length" else None)
    return Answer(choice.message.content, usage, stop)


# ---------- Testing a key, and the models it can use ----------

TEST_SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": False}


def _failed(ai, e):
    """What to tell the household when [e] stopped a call. For an address of its own, the same words
    for whatever kept it from answering, so the answer can't map which hosts and ports exist."""
    name = "that AI address" if ai["provider"] == "other" else PROVIDERS.get(ai["provider"], "the AI")
    named = name[0].upper() + name[1:]
    if isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError,
                      openai.AuthenticationError, openai.PermissionDeniedError)):
        return f"{named} didn't accept that key"
    if isinstance(e, (anthropic.NotFoundError, openai.NotFoundError)) and ai.get("model"):
        return f"{named} has no model called {ai['model']}"
    if isinstance(e, (anthropic.APIStatusError, openai.APIStatusError)):
        return f"{named} answered with an error ({e.status_code})"
    return f"Couldn't reach {name} from the server"


def key_works(ai, profile):
    """(True, None) if [ai] (as settings() gives it) answers with its model, else (False, why). One tiny
    answer in the shape Nightcap asks for (a fraction of a cent), charged to [profile]."""
    timeout = S.advanced.timeouts.ai_key_check_seconds
    try:
        answer = _ask(ai, "You check that an AI service works.", 'Answer {"ok": true}.', TEST_SCHEMA, "low", 1024,
                      think=False, timeout=timeout)
    except Exception as e:
        log.info("AI key test failed: %s", _why(e))
        return False, _failed(ai, e)
    record_usage("key_test", ai, price_of(ai), answer.usage or _guessed("", answer.text), profile)
    try:
        ok = not answer.stop and schema_problem(_parse(answer.text), TEST_SCHEMA) is None
    except ValueError:
        ok = False
    return (True, None) if ok else (False, "The model answered, but not in the shape Nightcap asks for")


# OpenAI's models that aren't for chat (pictures, speech, embeddings…).
NOT_CHAT = re.compile(r"audio|realtime|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|instruct|computer|babbage|davinci")


def models(ai):
    """The chat models [ai]'s key can use: [{"id", "price": [input, output] | None, "known"}], the known
    ones (with a price Nightcap knows) first. Raises ValueError with the household's words when the
    service won't list them."""
    timeout = S.advanced.timeouts.ai_key_check_seconds
    try:
        if ai["provider"] == "anthropic":
            found = [(m.id, None) for m in anthropic.Anthropic(api_key=ai["key"], timeout=timeout, max_retries=0).models.list(limit=100)]
        else:
            listed = list(_openai_client(ai, timeout).models.list())
            if ai["provider"] == "openai":
                found = [(m.id, None) for m in listed if re.match(r"(gpt-|o\d|chatgpt-)", m.id) and not NOT_CHAT.search(m.id)]
            elif ai["provider"] == "openrouter":
                found = [(m.id, _openrouter_price(m)) for m in listed if _openrouter_chat(m)]
            else:
                found = [(m.id, None) for m in listed]
    except Exception as e:
        log.info("Couldn't list the AI's models: %s", _why(e))
        raise ValueError(_failed({**ai, "model": None}, e))
    out = []
    for model_id, price in found[:1000]:
        price = price or price_of({**ai, "model": model_id, "price": None})
        out.append({"id": model_id, "price": list(price) if price else None, "known": price is not None})
    first = MODEL if ai["provider"] == "anthropic" else None
    return sorted(out, key=lambda m: (m["id"] != first, not m["known"], m["id"]))


def _openrouter_chat(m):
    """An OpenRouter model that writes text and takes a JSON schema (or at least JSON)."""
    extra = m.model_extra or {}
    params = extra.get("supported_parameters") or []
    writes = (extra.get("architecture") or {}).get("output_modalities") or ["text"]
    return "text" in writes and ("structured_outputs" in params or "response_format" in params)


def _openrouter_price(m):
    """OpenRouter's price for a model (it lists US dollars per token), per million; None when it has
    none or a varying one (its router, -1)."""
    pricing = (m.model_extra or {}).get("pricing") or {}
    try:
        pin, pout = float(pricing["prompt"]), float(pricing["completion"])
    except (KeyError, TypeError, ValueError):
        return None
    return None if pin < 0 or pout < 0 else (round(pin * 1e6, 6), round(pout * 1e6, 6))


def openrouter_price(key, model):
    """What OpenRouter lists [model] at, or None (it couldn't be asked, or has no price for it): kept
    with the household's choice when it gives none, so its calls can be checked against the limit
    before OpenRouter says what each cost."""
    try:
        return next((m["price"] for m in models({"provider": "openrouter", "key": key, "base_url": None, "price": None})
                     if m["id"] == model), None)
    except ValueError:
        return None
