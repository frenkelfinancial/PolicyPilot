// ============================================================
// supabase/functions/_shared/tcpa.ts
//
// TCPA quiet-hours support: best-effort NANP area-code -> IANA timezone
// lookup (no carrier LRN dip — this is an approximation, good enough to
// gate sends, not a definitive line-type lookup) plus the quiet-hours
// window check itself.
//
// Plain Node/Deno module — no runtime-specific globals — so it can run
// under both `node --test` (see tcpa.test.ts) and the Deno edge function
// runtime.
// ============================================================

export const DEFAULT_QUIET_HOURS_START = 8;  // 8am local
export const DEFAULT_QUIET_HOURS_END = 21;   // 9pm local
export const DEFAULT_FALLBACK_TIMEZONE = "America/New_York";

// Best-effort NANP area-code -> IANA timezone map. Not exhaustive — an
// unmapped area code falls back to DEFAULT_FALLBACK_TIMEZONE. Covers the
// major metro area codes across all six NANP timezones actually in use.
export const AREA_CODE_TIMEZONES: Record<string, string> = {
  // ---- Eastern ----
  "201": "America/New_York", "202": "America/New_York", "203": "America/New_York",
  "207": "America/New_York", "212": "America/New_York", "215": "America/New_York",
  "216": "America/New_York", "223": "America/New_York", "234": "America/New_York",
  "240": "America/New_York", "267": "America/New_York", "272": "America/New_York",
  "301": "America/New_York", "302": "America/New_York", "304": "America/New_York",
  "305": "America/New_York", "321": "America/New_York", "330": "America/New_York",
  "334": "America/Chicago",  "336": "America/New_York", "352": "America/New_York",
  "386": "America/New_York", "401": "America/New_York", "404": "America/New_York",
  "407": "America/New_York", "410": "America/New_York", "412": "America/New_York",
  "413": "America/New_York", "434": "America/New_York", "440": "America/New_York",
  "443": "America/New_York", "470": "America/New_York", "475": "America/New_York",
  "478": "America/New_York", "484": "America/New_York", "516": "America/New_York",
  "540": "America/New_York", "551": "America/New_York", "561": "America/New_York",
  "570": "America/New_York", "571": "America/New_York", "585": "America/New_York",
  "610": "America/New_York", "614": "America/New_York", "617": "America/New_York",
  "631": "America/New_York", "646": "America/New_York", "678": "America/New_York",
  "681": "America/New_York", "689": "America/New_York", "703": "America/New_York",
  "704": "America/New_York", "706": "America/New_York", "716": "America/New_York",
  "717": "America/New_York", "718": "America/New_York", "724": "America/New_York",
  "727": "America/New_York", "732": "America/New_York", "743": "America/New_York",
  "754": "America/New_York", "757": "America/New_York", "770": "America/New_York",
  "772": "America/New_York", "774": "America/New_York", "786": "America/New_York",
  "802": "America/New_York", "803": "America/New_York", "804": "America/New_York",
  "813": "America/New_York", "814": "America/New_York", "828": "America/New_York",
  "834": "America/New_York", "836": "America/New_York", "845": "America/New_York",
  "848": "America/New_York", "850": "America/Chicago",  "856": "America/New_York",
  "857": "America/New_York", "859": "America/New_York", "860": "America/New_York",
  "863": "America/New_York", "864": "America/New_York", "865": "America/New_York",
  "878": "America/New_York", "895": "America/New_York", "904": "America/New_York",
  "908": "America/New_York", "910": "America/New_York", "912": "America/New_York",
  "914": "America/New_York", "917": "America/New_York", "919": "America/New_York",
  "929": "America/New_York", "934": "America/New_York", "941": "America/New_York",
  "947": "America/New_York", "954": "America/New_York", "959": "America/New_York",
  "973": "America/New_York", "978": "America/New_York", "980": "America/New_York",
  "984": "America/New_York",

  // ---- Central ----
  "205": "America/Chicago", "210": "America/Chicago", "214": "America/Chicago",
  "217": "America/Chicago", "218": "America/Chicago", "219": "America/Chicago",
  "224": "America/Chicago", "225": "America/Chicago", "228": "America/Chicago",
  "251": "America/Chicago", "254": "America/Chicago", "256": "America/Chicago",
  "262": "America/Chicago", "281": "America/Chicago", "312": "America/Chicago",
  "314": "America/Chicago", "316": "America/Chicago", "318": "America/Chicago",
  "319": "America/Chicago", "320": "America/Chicago", "331": "America/Chicago",
  "337": "America/Chicago", "339": "America/New_York", "346": "America/Chicago",
  "361": "America/Chicago", "364": "America/Chicago", "409": "America/Chicago",
  "414": "America/Chicago", "417": "America/Chicago", "430": "America/Chicago",
  "432": "America/Chicago", "469": "America/Chicago", "479": "America/Chicago",
  "501": "America/Chicago", "504": "America/Chicago", "507": "America/Chicago",
  "512": "America/Chicago", "515": "America/Chicago", "563": "America/Chicago",
  "573": "America/Chicago", "580": "America/Chicago", "601": "America/Chicago",
  "608": "America/Chicago", "615": "America/Chicago", "618": "America/Chicago",
  "620": "America/Chicago", "630": "America/Chicago", "636": "America/Chicago",
  "641": "America/Chicago", "651": "America/Chicago", "660": "America/Chicago",
  "662": "America/Chicago", "708": "America/Chicago", "712": "America/Chicago",
  "713": "America/Chicago", "715": "America/Chicago", "731": "America/Chicago",
  "737": "America/Chicago", "751": "America/Chicago", "763": "America/Chicago",
  "769": "America/Chicago", "773": "America/Chicago", "779": "America/Chicago",
  "785": "America/Chicago", "815": "America/Chicago", "816": "America/Chicago",
  "817": "America/Chicago", "830": "America/Chicago", "832": "America/Chicago",
  "847": "America/Chicago", "870": "America/Chicago", "901": "America/Chicago",
  "903": "America/Chicago", "913": "America/Chicago", "918": "America/Chicago",
  "920": "America/Chicago", "931": "America/Chicago", "936": "America/Chicago",
  "940": "America/Chicago", "945": "America/Chicago", "952": "America/Chicago",
  "956": "America/Chicago", "972": "America/Chicago", "979": "America/Chicago",
  "985": "America/Chicago", "989": "America/Detroit",

  // ---- Mountain ----
  "208": "America/Denver", "303": "America/Denver", "307": "America/Denver",
  "385": "America/Denver", "406": "America/Denver", "435": "America/Denver",
  "505": "America/Denver", "575": "America/Denver", "719": "America/Denver",
  "720": "America/Denver", "801": "America/Denver", "970": "America/Denver",

  // ---- Arizona (Mountain, no DST) ----
  "480": "America/Phoenix", "520": "America/Phoenix", "602": "America/Phoenix",
  "623": "America/Phoenix", "928": "America/Phoenix",

  // ---- Pacific ----
  "206": "America/Los_Angeles", "209": "America/Los_Angeles", "213": "America/Los_Angeles",
  "253": "America/Los_Angeles", "279": "America/Los_Angeles", "310": "America/Los_Angeles",
  "323": "America/Los_Angeles", "341": "America/Los_Angeles", "360": "America/Los_Angeles",
  "408": "America/Los_Angeles", "415": "America/Los_Angeles", "424": "America/Los_Angeles",
  "425": "America/Los_Angeles", "442": "America/Los_Angeles", "458": "America/Los_Angeles",
  "503": "America/Los_Angeles", "509": "America/Los_Angeles", "510": "America/Los_Angeles",
  "530": "America/Los_Angeles", "541": "America/Los_Angeles", "559": "America/Los_Angeles",
  "562": "America/Los_Angeles", "564": "America/Los_Angeles", "619": "America/Los_Angeles",
  "626": "America/Los_Angeles", "650": "America/Los_Angeles", "657": "America/Los_Angeles",
  "661": "America/Los_Angeles", "669": "America/Los_Angeles", "702": "America/Los_Angeles",
  "707": "America/Los_Angeles", "725": "America/Los_Angeles", "747": "America/Los_Angeles",
  "760": "America/Los_Angeles", "775": "America/Los_Angeles", "805": "America/Los_Angeles",
  "808": "Pacific/Honolulu",     "818": "America/Los_Angeles", "820": "America/Los_Angeles",
  "831": "America/Los_Angeles", "858": "America/Los_Angeles", "909": "America/Los_Angeles",
  "916": "America/Los_Angeles", "925": "America/Los_Angeles", "949": "America/Los_Angeles",
  "951": "America/Los_Angeles", "971": "America/Los_Angeles",

  // ---- Alaska / Hawaii ----
  "907": "America/Anchorage",
};

// Toll-free prefixes have no geography — never trust them for a timezone.
const TOLL_FREE_AREA_CODES = new Set(["800", "888", "877", "866", "855", "844", "833", "822"]);

function extractAreaCode(e164: string): string {
  const digits = (e164 || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1, 4) : digits.slice(0, 3);
}

/**
 * Known IANA timezone for a mapped, non-toll-free NANP area code. Returns
 * null for an unmapped area code OR a toll-free prefix (800/888/877/866/
 * 855/844/833/822) — callers MUST treat null as "timezone unknown", not
 * silently default to any single zone (see isSendAllowedForPhone).
 */
export function knownTimezoneForPhone(e164: string): string | null {
  const areaCode = extractAreaCode(e164);
  if (TOLL_FREE_AREA_CODES.has(areaCode)) return null;
  return AREA_CODE_TIMEZONES[areaCode] ?? null;
}

/**
 * Best-effort recipient timezone from a US/CA E.164 phone number's area
 * code, for DISPLAY purposes only (e.g. an error message). Never use this
 * for compliance gating — an unmapped/toll-free number silently gets
 * `fallback` here, which is exactly the fail-open bug isSendAllowedForPhone
 * exists to avoid.
 */
export function timezoneForPhone(
  e164: string,
  fallback: string = DEFAULT_FALLBACK_TIMEZONE,
): string {
  return knownTimezoneForPhone(e164) ?? fallback;
}

/** True if `date` falls within [startHour, endHour) local time in `timeZone`. */
export function isWithinAllowedHours(
  date: Date,
  timeZone: string,
  startHour: number = DEFAULT_QUIET_HOURS_START,
  endHour: number = DEFAULT_QUIET_HOURS_END,
): boolean {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone,
  }).format(date);
  let hour = parseInt(hourStr, 10);
  if (hour === 24) hour = 0;
  return hour >= startHour && hour < endHour;
}

/**
 * Conservative allowed-hours check for a recipient whose timezone is
 * unknown (unmapped area code, or toll-free — no geography). Requires the
 * window to be open in BOTH America/New_York and America/Los_Angeles
 * simultaneously (roughly 11am-9pm Eastern / 8am-6pm Pacific), so no
 * contiguous-US timezone can ever be sent to outside its own 8am-9pm
 * window — the opposite of defaulting to a single zone and hoping.
 */
export function isWithinAllowedHoursUnknownTz(
  date: Date,
  startHour: number = DEFAULT_QUIET_HOURS_START,
  endHour: number = DEFAULT_QUIET_HOURS_END,
): boolean {
  return isWithinAllowedHours(date, "America/New_York", startHour, endHour) &&
    isWithinAllowedHours(date, "America/Los_Angeles", startHour, endHour);
}

/**
 * Single entry point for the TCPA quiet-hours compliance check: true if
 * sending to `e164` is currently allowed. Uses the recipient's known
 * timezone when the area code maps to one; falls back to the conservative
 * NY/LA intersection window for unmapped or toll-free numbers.
 */
export function isSendAllowedForPhone(e164: string, date: Date = new Date()): boolean {
  const tz = knownTimezoneForPhone(e164);
  return tz ? isWithinAllowedHours(date, tz) : isWithinAllowedHoursUnknownTz(date);
}
