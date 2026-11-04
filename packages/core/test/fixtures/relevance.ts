// The semantic search relevance set (stage 7 AC 7): a small CRM and 20 queries, each with the
// record it should find in the top 5. Queries are phrased the way people ask, mostly not with
// the record's own words, so plain full-text search alone misses many of them.

export interface RelevanceOrg {
  key: string;
  name: string;
  industry: string;
  description: string;
}
export interface RelevancePerson {
  key: string;
  name: string;
  description: string;
  location?: string;
}
export interface RelevanceNote {
  key: string;
  about: string; // a person or org key
  body: string;
}
export interface RelevanceTask {
  key: string;
  title: string;
  notes: string;
}

export const ORGS: RelevanceOrg[] = [
  { key: "helio", name: "Heliostat Power", industry: "Renewable energy", description: "Builds utility-scale solar farms and battery storage in Spain." },
  { key: "brewco", name: "Copper Kettle Brewing", industry: "Food and beverage", description: "Craft brewery with taprooms in three cities." },
  { key: "medix", name: "Medix Diagnostics", industry: "Healthcare", description: "Hospital laboratory software for pathology results." },
  { key: "freightly", name: "Freightly", industry: "Logistics", description: "Trucking and warehouse management for retailers." },
  { key: "ledgerly", name: "Ledgerly", industry: "Fintech", description: "Accounting automation and invoicing for small businesses." },
  { key: "campus", name: "Campus Learning Group", industry: "Education", description: "Online courses and tutoring for university students." },
  { key: "verde", name: "Verde Farms", industry: "Agriculture", description: "Organic vegetable growers supplying supermarkets." },
  { key: "shieldsec", name: "ShieldSec", industry: "Cybersecurity", description: "Penetration testing and security audits for banks." },
];

export const PEOPLE: RelevancePerson[] = [
  { key: "maria", name: "Maria Gonzalez", description: "Head of procurement, decides on energy contracts.", location: "Madrid" },
  { key: "tom", name: "Tom Becker", description: "Brewmaster and co-founder, loves hoppy ales." },
  { key: "priya", name: "Priya Raman", description: "Chief medical information officer at a hospital network." },
  { key: "liam", name: "Liam O'Brien", description: "Warehouse operations manager, runs night shifts." },
  { key: "sofia", name: "Sofia Rossi", description: "CFO who cares about cash flow and audit readiness." },
  { key: "kenji", name: "Kenji Watanabe", description: "Dean of online programmes.", location: "Tokyo" },
  { key: "amara", name: "Amara Okafor", description: "Security engineer, former ethical hacker." },
];

export const NOTES: RelevanceNote[] = [
  { key: "pricing", about: "ledgerly", body: "Sofia pushed back hard on the price; they think our subscription is too expensive compared with competitors." },
  { key: "outage", about: "medix", body: "Their lab system went down for six hours and results were delayed; they want an incident report." },
  { key: "renewal", about: "freightly", body: "Contract renewal is due in March; Liam wants to extend for two more years if the discount holds." },
  { key: "hiring", about: "campus", body: "They are recruiting twenty new tutors before the autumn semester starts." },
  { key: "expansion", about: "brewco", body: "Opening a fourth taproom in Melbourne next spring and need more kegs." },
  { key: "drought", about: "verde", body: "The dry summer hurt the harvest; irrigation costs doubled this year." },
  { key: "breach", about: "shieldsec", body: "A client bank suffered a phishing attack; ShieldSec is running the forensic investigation." },
  { key: "grid", about: "helio", body: "Waiting on the grid connection permit before the new solar plant can export electricity." },
];

export const TASKS: RelevanceTask[] = [
  { key: "invoice", title: "Send the overdue invoice reminder", notes: "Payment is 45 days late." },
  { key: "demo", title: "Book a product demo for the tutoring team", notes: "Show scheduling features." },
  { key: "kegs", title: "Quote for 200 stainless steel kegs", notes: "For the new taproom." },
];

/** A query and the key of the record it must find in the top 5. */
export const QUERIES: { query: string; expect: string }[] = [
  { query: "solar energy companies", expect: "helio" },
  { query: "brewery", expect: "brewco" },
  { query: "hospital laboratory software", expect: "medix" },
  { query: "warehouse trucking", expect: "freightly" },
  { query: "invoicing automation", expect: "ledgerly" },
  { query: "university tutoring", expect: "campus" },
  { query: "organic vegetables", expect: "verde" },
  { query: "security audits for banks", expect: "shieldsec" },
  { query: "who buys energy contracts", expect: "maria" },
  { query: "brewmaster", expect: "tom" },
  { query: "cash flow and audits", expect: "sofia" },
  { query: "ethical hacking", expect: "amara" },
  { query: "customers complaining the price is too expensive", expect: "pricing" },
  { query: "system downtime incident", expect: "outage" },
  { query: "contract renewals coming up", expect: "renewal" },
  { query: "recruiting new tutors", expect: "hiring" },
  { query: "opening another taproom", expect: "expansion" },
  { query: "harvest hurt by dry weather", expect: "drought" },
  { query: "phishing attack investigation", expect: "breach" },
  { query: "late payment reminders", expect: "invoice" },
];
