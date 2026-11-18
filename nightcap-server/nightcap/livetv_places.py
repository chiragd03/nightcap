"""Countries and languages as channel lists name them, for Live TV's filters (see livetv.py).

Lists say a channel's country with a two-letter code (tvg-country, or the end of its tvg-id:
"DDNational.in") or by name (a list whose settings read it from group-title), and its languages by
name or code (tvg-language="Hindi;English"). Here are the names the apps show for them, and the
names and codes lists use, each to one two-letter code.
"""

import unicodedata

# "INT": a channel for everywhere (or one whose list doesn't say where it's from).
INTERNATIONAL = "INT"

COUNTRIES = dict(line.split(" ", 1) for line in """\
INT International
AD Andorra
AE United Arab Emirates
AF Afghanistan
AG Antigua and Barbuda
AL Albania
AM Armenia
AO Angola
AR Argentina
AT Austria
AU Australia
AW Aruba
AZ Azerbaijan
BA Bosnia and Herzegovina
BB Barbados
BD Bangladesh
BE Belgium
BF Burkina Faso
BG Bulgaria
BH Bahrain
BI Burundi
BJ Benin
BN Brunei
BO Bolivia
BR Brazil
BS Bahamas
BT Bhutan
BW Botswana
BY Belarus
BZ Belize
CA Canada
CD DR Congo
CF Central African Republic
CG Congo
CH Switzerland
CI Côte d'Ivoire
CL Chile
CM Cameroon
CN China
CO Colombia
CR Costa Rica
CU Cuba
CV Cape Verde
CW Curaçao
CY Cyprus
CZ Czechia
DE Germany
DJ Djibouti
DK Denmark
DM Dominica
DO Dominican Republic
DZ Algeria
EC Ecuador
EE Estonia
EG Egypt
EH Western Sahara
ER Eritrea
ES Spain
ET Ethiopia
FI Finland
FJ Fiji
FO Faroe Islands
FR France
GA Gabon
GB United Kingdom
GD Grenada
GE Georgia
GF French Guiana
GH Ghana
GL Greenland
GM Gambia
GN Guinea
GP Guadeloupe
GQ Equatorial Guinea
GR Greece
GT Guatemala
GU Guam
GW Guinea-Bissau
GY Guyana
HK Hong Kong
HN Honduras
HR Croatia
HT Haiti
HU Hungary
ID Indonesia
IE Ireland
IL Israel
IN India
IQ Iraq
IR Iran
IS Iceland
IT Italy
JM Jamaica
JO Jordan
JP Japan
KE Kenya
KG Kyrgyzstan
KH Cambodia
KM Comoros
KN Saint Kitts and Nevis
KP North Korea
KR South Korea
KW Kuwait
KY Cayman Islands
KZ Kazakhstan
LA Laos
LB Lebanon
LC Saint Lucia
LI Liechtenstein
LK Sri Lanka
LR Liberia
LS Lesotho
LT Lithuania
LU Luxembourg
LV Latvia
LY Libya
MA Morocco
MC Monaco
MD Moldova
ME Montenegro
MG Madagascar
MK North Macedonia
ML Mali
MM Myanmar
MN Mongolia
MO Macao
MQ Martinique
MR Mauritania
MT Malta
MU Mauritius
MV Maldives
MW Malawi
MX Mexico
MY Malaysia
MZ Mozambique
NA Namibia
NC New Caledonia
NE Niger
NG Nigeria
NI Nicaragua
NL Netherlands
NO Norway
NP Nepal
NZ New Zealand
OM Oman
PA Panama
PE Peru
PF French Polynesia
PG Papua New Guinea
PH Philippines
PK Pakistan
PL Poland
PR Puerto Rico
PS Palestine
PT Portugal
PY Paraguay
QA Qatar
RE Réunion
RO Romania
RS Serbia
RU Russia
RW Rwanda
SA Saudi Arabia
SB Solomon Islands
SC Seychelles
SD Sudan
SE Sweden
SG Singapore
SI Slovenia
SK Slovakia
SL Sierra Leone
SM San Marino
SN Senegal
SO Somalia
SR Suriname
SS South Sudan
ST São Tomé and Príncipe
SV El Salvador
SX Sint Maarten
SY Syria
SZ Eswatini
TD Chad
TG Togo
TH Thailand
TJ Tajikistan
TL Timor-Leste
TM Turkmenistan
TN Tunisia
TO Tonga
TR Türkiye
TT Trinidad and Tobago
TW Taiwan
TZ Tanzania
UA Ukraine
UG Uganda
US United States
UY Uruguay
UZ Uzbekistan
VA Vatican City
VC Saint Vincent and the Grenadines
VE Venezuela
VG British Virgin Islands
VI US Virgin Islands
VN Vietnam
WS Samoa
XK Kosovo
YE Yemen
YT Mayotte
ZA South Africa
ZM Zambia
ZW Zimbabwe""".splitlines())

# Codes lists use for a country that aren't its own.
COUNTRY_ALIASES = {"UK": "GB", "EN": "GB", "WORLD": INTERNATIONAL, "INTERNATIONAL": INTERNATIONAL, "WW": INTERNATIONAL}

# code, English name, then the other names and codes lists use for it.
_LANGUAGES = """\
af Afrikaans|afr
am Amharic|amh
ar Arabic|ara|العربية
as Assamese|asm
az Azerbaijani|aze
be Belarusian|bel
bg Bulgarian|bul
bn Bengali|ben|bangla|বাংলা
bs Bosnian|bos
ca Catalan|cat
cs Czech|ces|cze
cy Welsh|cym|wel
da Danish|dan
de German|deu|ger|deutsch
el Greek|ell|gre|modern greek
en English|eng
es Spanish|spa|español|castilian
et Estonian|est
eu Basque|eus|baq
fa Persian|fas|per|farsi
fi Finnish|fin
fil Filipino|tagalog|tgl
fr French|fra|fre|français
ga Irish|gle
gl Galician|glg
gu Gujarati|guj|ગુજરાતી
he Hebrew|heb
hi Hindi|hin|हिन्दी|हिंदी
hr Croatian|hrv
hu Hungarian|hun
hy Armenian|hye|arm
id Indonesian|ind|bahasa indonesia
is Icelandic|isl|ice
it Italian|ita|italiano
ja Japanese|jpn|日本語
ka Georgian|kat|geo
kk Kazakh|kaz
km Khmer|khm|central khmer
kn Kannada|kan|ಕನ್ನಡ
ko Korean|kor|한국어
ku Kurdish|kur
ky Kyrgyz|kir|kirghiz
lo Lao|lao
lt Lithuanian|lit
lv Latvian|lav
mk Macedonian|mkd|mac
ml Malayalam|mal|മലയാളം
mn Mongolian|mon
mr Marathi|mar|मराठी
ms Malay|msa|may
mt Maltese|mlt
my Burmese|mya|bur
ne Nepali|nep|नेपाली
nl Dutch|nld|dut|flemish
no Norwegian|nor|nob|nno|norwegian bokmål
or Odia|ori|oriya
pa Punjabi|pan|panjabi|ਪੰਜਾਬੀ
pl Polish|pol
ps Pashto|pus|pushto
pt Portuguese|por|português
ro Romanian|ron|rum|moldavian
ru Russian|rus|русский
si Sinhala|sin|sinhalese
sk Slovak|slk|slo
sl Slovenian|slv
so Somali|som
sq Albanian|sqi|alb
sr Serbian|srp
sv Swedish|swe
sw Swahili|swa
ta Tamil|tam|தமிழ்
te Telugu|tel|తెలుగు
th Thai|tha
tk Turkmen|tuk
tr Turkish|tur|türkçe
uk Ukrainian|ukr
ur Urdu|urd|اردو
uz Uzbek|uzb
vi Vietnamese|vie
zh Chinese|zho|chi|mandarin|cantonese|yue|中文"""

LANGUAGES = {}       # code -> English name
_LANGUAGE_OF = {}    # any name or code (lower case) -> code
for _line in _LANGUAGES.splitlines():
    _code, _rest = _line.split(" ", 1)
    _names = _rest.split("|")
    LANGUAGES[_code] = _names[0]
    for _n in [_code, *_names]:
        _LANGUAGE_OF[_n.lower()] = _code


def _fold(name):
    """A name to compare: lower case, without accents or extra spaces ("Türkiye": "turkiye")."""
    plain = "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))
    return " ".join(plain.lower().split())


# Countries by name: the name shown, and other names lists use for it.
_COUNTRY_NAMES = {**{_fold(name): code for code, name in COUNTRIES.items()},
                  **{_fold(name): code for name, code in {
                      "USA": "US", "United States of America": "US", "Great Britain": "GB", "UAE": "AE",
                      "Czech Republic": "CZ", "Ivory Coast": "CI", "Democratic Republic of the Congo": "CD",
                      "Republic of the Congo": "CG"}.items()}}


def country_code(raw):
    """A list's country (a code, any case, or a name: "India", "Türkiye") as a known two-letter
    code, or None."""
    code = (raw or "").strip().upper()
    code = COUNTRY_ALIASES.get(code, code)
    return code if code in COUNTRIES else _COUNTRY_NAMES.get(_fold(raw or ""))


def language_code(raw):
    """A list's language (a name or a code) as a known code, or None."""
    return _LANGUAGE_OF.get((raw or "").strip().lower())
