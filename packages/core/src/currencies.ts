// Currency codes the UI offers for the base currency (browser-safe; ADR 0101).
/** ISO 4217 codes offered in Settings → General (any valid three-letter code is accepted). */
export const COMMON_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "CAD",
  "NZD",
  "JPY",
  "CHF",
  "SGD",
  "INR",
  "SEK",
  "NOK",
  "DKK",
  "ZAR",
  "BRL",
  "MXN",
  "HKD",
  "CNY",
] as const;
