"""The household's AI (ai.py) with fake services: answers checked against their schema and asked again
once, usage kept for failed calls too, the price rules and the monthly limit, the OpenAI-compatible
request, and an address of the household's own reached only through checked connections. No paid
calls: Anthropic's library is replaced, and OpenAI's talks to a fake transport.

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_ai
"""

import json
import os
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")
os.environ.setdefault("SECRETS_KEY", "test-secret")

import httpx2  # noqa: E402
import openai  # noqa: E402

from nightcap import ai, http, sources  # noqa: E402

SCHEMA = {"type": "object",
          "properties": {"picks": {"type": "array", "items": {
              "type": "object", "properties": {"key": {"type": "string"}, "n": {"type": "integer"}},
              "required": ["key", "n"], "additionalProperties": False}},
              "kind": {"type": "string", "enum": ["movie", "series"]}},
          "required": ["picks", "kind"], "additionalProperties": False}
GOOD = {"picks": [{"key": "m1", "n": 1}], "kind": "movie"}


class Household:
    """The database's part: the household's AI, its limit and spend, and the usage recorded."""

    def __init__(self, test, provider="openai", model="gpt-5-mini", price=None, limit=None, spend=0.0):
        self.ai = {"provider": provider, "key": "k" * 24, "model": model, "base_url": None, "price": price}
        self.limit, self.spend, self.recorded = limit, spend, []
        self.patchers = [mock.patch.object(ai, "settings", lambda account=None: dict(self.ai)),
                         mock.patch.object(ai.accounts, "monthly_limit", lambda: self.limit),
                         mock.patch.object(ai.accounts, "account_id", lambda: "acct"),
                         mock.patch.object(ai.accounts, "timezone", lambda: "UTC"),
                         mock.patch.object(ai.store, "month_spend", lambda account, tz: self.spend),
                         mock.patch.object(ai.store, "record_usage", lambda *a: self.recorded.append(a)),
                         mock.patch.object(ai, "me", lambda: "profile")]
        for p in self.patchers:
            p.start()
            test.addCleanup(p.stop)


# ---------- A fake OpenAI-compatible service, behind OpenAI's own library ----------

class FakeOpenAI:
    """Answers Chat Completions from a list of replies (dicts: an answer, or {"status": 400}); keeps
    every request's body."""

    def __init__(self, *replies):
        self.replies, self.bodies = list(replies), []

    def handler(self, request):
        body = json.loads(request.read() or b"{}")
        self.bodies.append(body)
        reply = self.replies.pop(0)
        if "status" in reply:
            return httpx2.Response(reply["status"], json={"error": {"message": "no"}})
        return httpx2.Response(200, json=reply)

    def client(self, ai_, timeout=None):
        return openai.OpenAI(api_key="x", base_url="https://fake.example/v1", max_retries=0,
                             http_client=httpx2.Client(transport=httpx2.MockTransport(self.handler)))


def completion(content, finish="stop", prompt=100, out=20, cost=None, refusal=None):
    usage = {"prompt_tokens": prompt, "completion_tokens": out, "total_tokens": prompt + out}
    if cost is not None:
        usage["cost"] = cost
    return {"id": "c1", "object": "chat.completion", "created": 1, "model": "m",
            "choices": [{"index": 0, "finish_reason": finish,
                         "message": {"role": "assistant", "content": content, "refusal": refusal}}],
            "usage": usage}


class OpenAICompatible(unittest.TestCase):
    def setUp(self):
        ai._PLAIN.clear()

    def fake(self, *replies):
        fake = FakeOpenAI(*replies)
        p = mock.patch.object(ai, "_openai_client", fake.client)
        p.start()
        self.addCleanup(p.stop)
        return fake

    def test_a_good_answer_with_a_strict_schema_and_effort_for_a_reasoning_model(self):
        h = Household(self, model="gpt-5-mini", price=[1.0, 2.0])
        fake = self.fake(completion(json.dumps(GOOD)))
        self.assertEqual(ai.ask_ai("sys", "prompt", SCHEMA, effort="medium", max_tokens=32000), GOOD)
        body = fake.bodies[0]
        self.assertEqual(body["response_format"]["type"], "json_schema")
        self.assertTrue(body["response_format"]["json_schema"]["strict"])
        self.assertEqual(body["reasoning_effort"], "medium")
        # (A reasoning model's thinking is in what it writes: not cut to most_output_plain.)
        self.assertEqual(body["max_completion_tokens"], 32000)
        self.assertEqual(len(h.recorded), 1)
        _, purpose, model, tin, tout, cost = h.recorded[0]
        self.assertEqual((purpose, model, tin, tout), ("rebuild", "gpt-5-mini", 100, 20))
        self.assertAlmostEqual(cost, 100 / 1e6 * 1.0 + 20 / 1e6 * 2.0)

    def test_no_effort_for_a_model_that_doesnt_reason_and_its_output_is_capped(self):
        Household(self, model="gpt-4.1", price=[1.0, 2.0])
        fake = self.fake(completion(json.dumps(GOOD)))
        ai.ask_ai("sys", "prompt", SCHEMA, max_tokens=32000)
        self.assertNotIn("reasoning_effort", fake.bodies[0])
        self.assertEqual(fake.bodies[0]["max_completion_tokens"], ai.S.ai.most_output_plain)
        for model in ("gpt-5-chat-latest", "llama-3.3-70b"):
            self.assertIsNone(ai.REASONING.match(model), model)
        for model in ("o3", "o4-mini", "gpt-5", "gpt-5.1", "openai/gpt-5-mini"):
            self.assertIsNotNone(ai.REASONING.match(model), model)

    def test_an_answer_in_the_wrong_shape_is_asked_again_once_as_plain_json_then_given_up(self):
        h = Household(self, model="gpt-4.1", price=[1.0, 2.0])
        fake = self.fake(completion('{"picks": [{"key": "m1"}], "kind": "movie"}'), completion("not json at all"))
        with self.assertRaises(ai.AIUnavailable) as e:
            ai.ask_ai("sys", "prompt", SCHEMA)
        self.assertEqual(e.exception.reason, "failed")
        self.assertEqual(len(fake.bodies), 2)
        # The second time: JSON, with the schema in the prompt (and the word JSON, which that mode needs).
        self.assertEqual(fake.bodies[1]["response_format"], {"type": "json_object"})
        self.assertIn('"picks"', fake.bodies[1]["messages"][0]["content"])
        self.assertIn("JSON", fake.bodies[1]["messages"][0]["content"])
        # Both calls were paid for: both kept.
        self.assertEqual(len(h.recorded), 2)

    def test_the_retry_can_succeed_and_fenced_json_is_read(self):
        Household(self, model="gpt-4.1", price=[1.0, 2.0])
        self.fake(completion("{}"), completion("```json\n" + json.dumps(GOOD) + "\n```"))
        self.assertEqual(ai.ask_ai("sys", "prompt", SCHEMA), GOOD)

    def test_a_model_that_refuses_a_json_schema_is_asked_for_json_at_once_and_remembered(self):
        Household(self, provider="other", model="llama3", price=[0, 0])
        fake = self.fake({"status": 400}, completion(json.dumps(GOOD)), completion(json.dumps(GOOD)))
        self.assertEqual(ai.ask_ai("sys", "prompt", SCHEMA), GOOD)
        self.assertEqual([b["response_format"]["type"] for b in fake.bodies], ["json_schema", "json_object"])
        ai.ask_ai("sys", "prompt", SCHEMA)
        self.assertEqual(fake.bodies[2]["response_format"]["type"], "json_object")

    def test_cut_short_or_refused_isnt_asked_again_but_is_recorded(self):
        for reply in (completion('{"picks": [', finish="length", out=16384),
                      completion(None, refusal="I can't help with that")):
            h = Household(self, model="gpt-4.1", price=[1.0, 2.0])
            fake = self.fake(reply)
            with self.assertRaises(ai.AIUnavailable) as e:
                ai.ask_ai("sys", "prompt", SCHEMA)
            self.assertEqual(e.exception.reason, "failed")
            self.assertEqual(len(fake.bodies), 1)
            self.assertEqual(len(h.recorded), 1)

    def test_a_refused_key_or_missing_model_is_rejected_not_failed(self):
        Household(self, model="gpt-4.1", price=[1, 1])
        for status in (401, 403, 404):
            # (A 404 is first taken as "no JSON schema here", and asked again without one.)
            self.fake({"status": status}, {"status": status})
            with self.assertRaises(ai.AIUnavailable) as e:
                ai.ask_ai("sys", "prompt", SCHEMA)
            self.assertEqual(e.exception.reason, "rejected")

    def test_a_service_error_is_ai_unavailable(self):
        h = Household(self, model="gpt-4.1", price=[1.0, 2.0])
        self.fake({"status": 500})
        with self.assertRaises(ai.AIUnavailable) as e:
            ai.ask_ai("sys", "prompt", SCHEMA)
        self.assertEqual(e.exception.reason, "failed")
        self.assertEqual(h.recorded, [])

    def test_openrouter_cost_is_taken_from_its_answer_and_its_provider_rules_are_sent(self):
        h = Household(self, provider="openrouter", model="anthropic/claude-haiku-5-5", price=[1.0, 2.0])
        fake = self.fake(completion(json.dumps(GOOD), cost=0.0042))
        ai.ask_ai("sys", "prompt", SCHEMA)
        self.assertEqual(fake.bodies[0]["provider"], {"require_parameters": True, "data_collection": "deny"})
        self.assertNotIn("reasoning", fake.bodies[0])
        self.assertEqual(h.recorded[0][-1], 0.0042)

    def test_openrouter_reasoning_models_get_its_own_effort(self):
        Household(self, provider="openrouter", model="openai/gpt-5-mini", price=[1.0, 2.0])
        fake = self.fake(completion(json.dumps(GOOD)))
        ai.ask_ai("sys", "prompt", SCHEMA, effort="low")
        self.assertEqual(fake.bodies[0]["reasoning"], {"effort": "low"})
        self.assertNotIn("reasoning_effort", fake.bodies[0])

    def test_a_service_without_usage_is_counted_by_its_length(self):
        h = Household(self, provider="other", model="llama3", price=[1.0, 1.0])
        reply = completion(json.dumps(GOOD))
        del reply["usage"]
        self.fake(reply)
        ai.ask_ai("sys", "x" * 4000, SCHEMA)
        self.assertGreaterEqual(h.recorded[0][3], 1000)
        self.assertGreater(h.recorded[0][4], 0)


# ---------- Anthropic, with its library replaced ----------

class FakeStream:
    def __init__(self, response):
        self.response = response

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.response


def message(text, stop="end_turn", tin=50, tout=10):
    return SimpleNamespace(stop_reason=stop, stop_details=None, content=[SimpleNamespace(type="text", text=text)],
                           usage=SimpleNamespace(input_tokens=tin, output_tokens=tout))


class Anthropic(unittest.TestCase):
    def fake(self, *responses):
        calls = []
        replies = list(responses)

        def stream(**kwargs):
            calls.append(kwargs)
            return FakeStream(replies.pop(0))
        client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))
        p = mock.patch.object(ai.anthropic, "Anthropic", lambda **kw: client)
        p.start()
        self.addCleanup(p.stop)
        return calls

    def test_built_in_price_and_thinking_off_per_model(self):
        cases = {"claude-haiku-5-5": {"type": "disabled"}, "claude-sonnet-5-5": {"type": "between_tools"},
                 "claude-opus-5-5": None}
        for model, thinking in cases.items():
            h = Household(self, provider="anthropic", model=model)
            calls = self.fake(message(json.dumps(GOOD)))
            self.assertEqual(ai.ask_ai("sys", "prompt", SCHEMA, effort="low", think=False), GOOD)
            self.assertEqual(calls[0].get("thinking"), thinking, model)
            self.assertEqual(calls[0]["output_config"]["effort"], "low")
            self.assertEqual(calls[0]["output_config"]["format"]["schema"], SCHEMA)
            self.assertEqual("fallbacks" in calls[0], model != "claude-haiku-5-5", model)
            pin, pout = ai.PRICES[model]
            self.assertAlmostEqual(h.recorded[0][-1], round(50 / 1e6 * pin + 10 / 1e6 * pout, 6))

    def test_a_refusal_or_max_tokens_is_recorded_then_unavailable(self):
        for stop in ("refusal", "max_tokens"):
            h = Household(self, provider="anthropic", model="claude-haiku-5-5")
            calls = self.fake(message("", stop=stop))
            with self.assertRaises(ai.AIUnavailable) as e:
                ai.ask_ai("sys", "prompt", SCHEMA)
            self.assertEqual(e.exception.reason, "failed")
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(h.recorded), 1)

    def test_a_wrong_shape_is_asked_again(self):
        Household(self, provider="anthropic", model="claude-haiku-5-5")
        calls = self.fake(message('{"picks": "no", "kind": "movie"}'), message(json.dumps(GOOD)))
        self.assertEqual(ai.ask_ai("sys", "prompt", SCHEMA), GOOD)
        self.assertEqual(len(calls), 2)


# ---------- Prices and the monthly limit ----------

class Prices(unittest.TestCase):
    def test_which_price_counts(self):
        self.assertEqual(ai.price_of({"provider": "anthropic", "model": "claude-haiku-5-5", "price": [9, 9]}),
                         ai.PRICES["claude-haiku-5-5"])
        self.assertEqual(ai.price_of({"provider": "openai", "model": "gpt-unknown", "price": [1, 2]}), (1, 2))
        # An address of the household's own or OpenRouter: never the built-in table.
        self.assertIsNone(ai.price_of({"provider": "other", "model": "claude-haiku-5-5", "price": None}))
        self.assertEqual(ai.price_of({"provider": "other", "model": "x", "price": [0, 0]}), (0, 0))

    def test_a_model_without_a_price_is_still_asked_uncounted_and_not_held_to_the_limit(self):
        # Over this month's limit already: a priced model would be refused.
        h = Household(self, provider="other", model="llama3", price=None, limit=1.0, spend=5.0)
        self.assertTrue(ai.usable())
        fake = FakeOpenAI(completion(json.dumps(GOOD), prompt=100, out=20))
        with mock.patch.object(ai, "_openai_client", fake.client):
            self.assertEqual(ai.ask_ai("sys", "prompt", SCHEMA), GOOD)
        # Its tokens are kept, its cost isn't known.
        self.assertEqual(h.recorded[0][3:], (100, 20, None))
        # Given a price, it's counted and held to the limit again.
        h.ai["price"] = [1.0, 1.0]
        self.assertFalse(ai.usable())

    def test_the_spend_says_whether_the_model_is_priced(self):
        h = Household(self, provider="other", model="llama3", price=None, limit=1.0)
        month = {"month_cost": 3.0, "month_calls": 4, "month_unpriced_calls": 2}
        with mock.patch.object(ai.store, "usage_summary", lambda account, tz: dict(month)):
            out = ai.usage_summary()
            self.assertEqual((out["priced"], out["limitReached"]), (False, False))
            h.ai["price"] = [0.5, 0.5]
            out = ai.usage_summary()
            self.assertEqual((out["priced"], out["limitReached"]), (True, True))

    def test_no_key_or_model(self):
        h = Household(self)
        h.ai["model"] = None
        with self.assertRaises(ai.AIUnavailable) as e:
            ai.check_allowed()
        # (A key with no model: said as "choose the model", not "no key".)
        self.assertEqual(e.exception.reason, "no_model")
        h.ai["key"] = None
        with self.assertRaises(ai.AIUnavailable) as e:
            ai.check_allowed()
        self.assertEqual(e.exception.reason, "no_key")

    def test_a_call_that_could_pass_the_limit_isnt_made(self):
        # $1 per million out: 32,000 tokens could cost $0.032, and only $0.02 is left.
        Household(self, model="gpt-4.1", price=[0.0, 1.0], limit=1.0, spend=0.98)
        with self.assertRaises(ai.AIUnavailable) as e:
            ai.check_allowed(0, 32000)
        self.assertEqual(e.exception.reason, "limit")
        # A smaller one fits.
        ai.check_allowed(0, 4000)
        # A free model is never over it, until the month's spend is.
        Household(self, model="gpt-4.1", price=[0, 0], limit=1.0, spend=0.98)
        ai.check_allowed(400000, 32000)


# ---------- The schema checker ----------

class Schema(unittest.TestCase):
    def test_shapes(self):
        self.assertIsNone(ai.schema_problem(GOOD, SCHEMA))
        bad = [{"picks": [], "kind": "film"}, {"picks": [{"key": "m1", "n": "1"}], "kind": "movie"},
               {"picks": [{"key": "m1", "n": True}], "kind": "movie"}, {"picks": [], "kind": "movie", "x": 1},
               {"kind": "movie"}, [], {"picks": {}, "kind": "movie"}]
        for value in bad:
            self.assertIsNotNone(ai.schema_problem(value, SCHEMA), value)


# ---------- Testing a key ----------

class KeyTest(unittest.TestCase):
    def test_a_key_test_is_one_small_real_answer(self):
        h = Household(self, provider="openai", model="gpt-4.1", price=None)
        fake = FakeOpenAI(completion('{"ok": true}', prompt=20, out=5))
        with mock.patch.object(ai, "_openai_client", fake.client):
            self.assertEqual(ai.key_works(dict(h.ai), "admin"), (True, None))
        self.assertLessEqual(fake.bodies[0]["max_completion_tokens"], 1024)
        self.assertEqual(h.recorded[0][:2], ("admin", "key_test"))

    def test_a_refused_key(self):
        h = Household(self, provider="openai", model="gpt-4.1")
        fake = FakeOpenAI({"status": 401})
        with mock.patch.object(ai, "_openai_client", fake.client):
            self.assertEqual(ai.key_works(dict(h.ai), "admin"), (False, "OpenAI didn't accept that key"))


# ---------- Saving the household's choice ----------

class Saving(unittest.TestCase):
    def setUp(self):
        self.saved = {"ai_api_key": None, "ai_provider": None, "ai_model": None, "ai_base_url": None, "ai_price": None}
        for p in (mock.patch.object(sources, "_save", lambda account, change: change(self.saved)),
                  mock.patch.object(sources.store, "secrets", lambda account, conn=None: dict(self.saved))):
            p.start()
            self.addCleanup(p.stop)

    def test_save_change_the_model_keeping_the_key_then_remove(self):
        sources.set_ai("a", "anthropic", "sk-ant-" + "x" * 30, "claude-haiku-5-5")
        self.assertEqual(self.saved["ai_model"], "claude-haiku-5-5")
        sources.set_ai("a", "anthropic", None, "claude-sonnet-5-5")
        self.assertEqual((self.saved["ai_api_key"], self.saved["ai_model"]), ("sk-ant-" + "x" * 30, "claude-sonnet-5-5"))
        self.assertEqual(sources._ai(self.saved)["price"], list(ai.PRICES["claude-sonnet-5-5"]))
        # Another provider's key isn't kept for it.
        with self.assertRaises(ValueError):
            sources.set_ai("a", "openai", None, "gpt-5-mini")
        sources.set_ai("a", "anthropic", None)
        self.assertEqual(set(self.saved.values()), {None})

    def test_a_new_model_is_tested_with_the_saved_key(self):
        sources.set_ai("a", "openai", "k" * 24, "gpt-5-mini", price=[1, 2])
        self.assertEqual(sources.with_saved_key("a", "openai", "gpt-4.1"),
                         {"provider": "openai", "key": "k" * 24, "model": "gpt-4.1", "base_url": None, "price": None})
        # The saved model keeps its saved price.
        self.assertEqual(sources.with_saved_key("a", "openai", "gpt-5-mini")["price"], [1.0, 2.0])
        with self.assertRaises(ValueError):
            sources.with_saved_key("a", "anthropic", "claude-haiku-5-5")

    def test_the_saved_key_goes_only_to_its_saved_address(self):
        with mock.patch.object(sources, "AT_HOME", False):
            sources.set_ai("a", "other", "x", "llama3", "https://ai.example.com/v1")
            self.assertEqual(sources.with_saved_key("a", "other", "llama4")["base_url"], "https://ai.example.com/v1")
            self.assertEqual(sources.with_saved_key("a", "other", "llama4", "https://ai.example.com/v1/")["model"], "llama4")
            for change in (lambda: sources.with_saved_key("a", "other", "llama4", "https://elsewhere.example/v1"),
                           lambda: sources.set_ai("a", "other", None, "llama4", "https://elsewhere.example/v1"),
                           lambda: sources.ai_models("a", "other", None, "https://elsewhere.example/v1")):
                with self.assertRaises(ValueError):
                    change()
        self.assertEqual(self.saved["ai_base_url"], "https://ai.example.com/v1")

    def test_a_model_and_a_sane_price_are_needed(self):
        for model, price in ((None, None), ("has space", None), ("m", [1]), ("m", [-1, 2]), ("m", [True, 1])):
            with self.assertRaises(ValueError):
                sources.set_ai("a", "openai", "k" * 24, model, price=price)

    def test_openrouters_price_is_looked_up_when_none_is_given(self):
        with mock.patch.object(ai, "openrouter_price", lambda key, model: (0.5, 1.5)):
            sources.set_ai("a", "openrouter", "k" * 24, "anthropic/claude-haiku-5-5")
        self.assertEqual(self.saved["ai_price"], [0.5, 1.5])

    def test_an_other_address_is_shown_masked(self):
        with mock.patch.object(sources, "AT_HOME", False):
            sources.set_ai("a", "other", "x", "llama3", "https://ai.example.com/secret-path-abcd/v1", [0, 0])
        shown = sources._ai(self.saved)
        self.assertEqual(shown["baseUrl"], "https://ai.example.com/…d/v1")
        self.assertEqual(shown["price"], [0.0, 0.0])

    def test_openrouter_listing_keeps_chat_models_with_their_price(self):
        listed = {"object": "list", "data": [
            {"id": "a/chat", "object": "model", "created": 1, "owned_by": "x",
             "pricing": {"prompt": "0.000001", "completion": "0.000002"},
             "supported_parameters": ["response_format", "structured_outputs"],
             "architecture": {"output_modalities": ["text"]}},
            {"id": "a/picture", "object": "model", "created": 1, "owned_by": "x", "pricing": {"prompt": "0", "completion": "0"},
             "supported_parameters": ["response_format"], "architecture": {"output_modalities": ["image"]}},
            {"id": "openrouter/auto", "object": "model", "created": 1, "owned_by": "x",
             "pricing": {"prompt": "-1", "completion": "-1"}, "supported_parameters": ["response_format"]}]}

        def client(ai_, timeout=None):
            return openai.OpenAI(api_key="x", base_url="https://fake.example/v1", max_retries=0, http_client=httpx2.Client(
                transport=httpx2.MockTransport(lambda r: httpx2.Response(200, json=listed))))
        with mock.patch.object(ai, "_openai_client", client):
            found = ai.models({"provider": "openrouter", "key": "k", "base_url": None, "price": None})
        self.assertEqual(found, [{"id": "a/chat", "price": [1.0, 2.0], "known": True},
                                 {"id": "openrouter/auto", "price": None, "known": False}])


# ---------- An address of the household's own ----------

class Redirecting(BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(302)
        self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "llama3", "object": "model", "created": 1,
                                                       "owned_by": "me"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class OwnAddress(unittest.TestCase):
    def test_the_address_is_checked_as_given(self):
        with mock.patch.object(sources, "AT_HOME", False):
            with self.assertRaises(ValueError):
                sources.check_base_url("http://ai.example.com/v1")
            with self.assertRaises(ValueError):
                sources.check_base_url("https://user:pw@ai.example.com/v1")
            self.assertEqual(sources.check_base_url(" https://ai.example.com/v1/ "), "https://ai.example.com/v1")
        with mock.patch.object(sources, "AT_HOME", True):
            self.assertEqual(sources.check_base_url("http://192.168.1.5:11434/v1"), "http://192.168.1.5:11434/v1")

    def test_blocked_addresses_get_the_same_words(self):
        blocked = {"localhost": "127.0.0.1", "metadata.example": "169.254.169.254", "lan.example": "10.0.0.5",
                   "closed.example": "93.184.215.14"}

        def lookup(host, port, *a, **kw):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (blocked[host], port))]

        def refuse(self, address):
            raise ConnectionRefusedError("refused")
        words = set()
        with mock.patch.object(http, "AT_HOME", False), mock.patch.object(http.socket, "getaddrinfo", lookup), \
                mock.patch.object(socket.socket, "connect", refuse):
            for host in blocked:
                found = {"provider": "other", "key": "x", "model": "llama3", "price": [0, 0],
                         "base_url": f"https://{host}/v1"}
                ok, why = ai.key_works(found, "admin")
                self.assertFalse(ok)
                words.add(why)
                with self.assertRaises(ValueError) as e:
                    ai.models(found)
                words.add(str(e.exception))
        self.assertEqual(words, {"Couldn't reach that AI address from the server"})

    def test_a_port_other_than_80_or_443_is_blocked_in_the_cloud(self):
        with mock.patch.object(http, "AT_HOME", False):
            self.assertFalse(http.allowed("93.184.215.14", 8080))
            self.assertTrue(http.allowed("93.184.215.14", 443))
            self.assertFalse(http.allowed("192.168.1.5", 443))
        with mock.patch.object(http, "AT_HOME", True):
            self.assertTrue(http.allowed("192.168.1.5", 11434))
            self.assertFalse(http.allowed("169.254.169.254", 80))

    def test_it_answers_through_the_checked_connection_and_redirects_arent_followed(self):
        server = HTTPServer(("127.0.0.1", 0), Redirecting)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        checked = []

        def allowed(address, p):
            checked.append((address, p))
            return address == "127.0.0.1" and p == port   # (only this test's own server)
        found = {"provider": "other", "key": "x", "model": "llama3", "price": [0, 0],
                 "base_url": f"http://127.0.0.1:{port}/v1"}
        with mock.patch.object(http, "allowed", allowed):
            self.assertEqual([m["id"] for m in ai.models(found)], ["llama3"])
            # The answer is a redirect to the metadata service: not followed, so the call fails.
            ok, why = ai.key_works(found, "admin")
        self.assertEqual((ok, why), (False, "That AI address answered with an error (302)"))
        self.assertTrue(checked)
        self.assertTrue(all(a == "127.0.0.1" for a, _ in checked))


if __name__ == "__main__":
    unittest.main()


class TrustedCost(unittest.TestCase):
    """Only OpenRouter's own "cost" is taken, and only a number of 0 or more (ai._openai)."""

    def usage(self, provider, cost):
        import types
        u = types.SimpleNamespace(prompt_tokens=10, completion_tokens=5, model_extra={"cost": cost})
        msg = types.SimpleNamespace(refusal=None, content='{"ok": true}')
        response = types.SimpleNamespace(usage=u, choices=[types.SimpleNamespace(message=msg, finish_reason="stop")])
        client = mock.Mock()
        client.chat.completions.create.return_value = response
        with mock.patch.object(ai, "_openai_client", return_value=client):
            answer = ai._openai({"provider": provider, "model": "m", "key": "k", "base_url": None},
                                "s", "p", {"type": "object", "properties": {"ok": {"type": "boolean"}},
                                           "required": ["ok"], "additionalProperties": False},
                                "low", 100, False)
        return answer.usage.cost

    def test_only_openrouters_number(self):
        self.assertEqual(self.usage("openrouter", 0.002), 0.002)
        self.assertIsNone(self.usage("other", 0.002))
        self.assertIsNone(self.usage("openrouter", "0.002"))
        self.assertIsNone(self.usage("openrouter", -1))


# ---------- Smart Search when the AI fails ----------

class SmartSearch(unittest.TestCase):
    def search(self, reason):
        from nightcap import search

        def fails(q):
            raise ai.AIUnavailable(reason)
        with mock.patch.object(search, "ai_search", fails), \
                mock.patch.object(search, "cached", lambda key, f, ttl=None: f()), \
                mock.patch.object(search, "quick_search", lambda q: {"titles": []}):
            return search.ai_search_cards("q")

    def test_failing_this_time_is_an_error_and_not_a_note(self):
        # (An error: the apps offer to try again and keep Smart Search; a note means no AI.)
        with self.assertRaises(ai.AIUnavailable):
            self.search("failed")
        for reason in ("limit", "no_model", "no_key", "rejected"):
            self.assertIn("note", self.search(reason))
