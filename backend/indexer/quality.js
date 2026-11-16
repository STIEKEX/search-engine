// Should a page go into the index at all? The crawler keeps everything it
// fetched; the INDEXER decides what is worth searching. Two rules:
//
//   1. notEnglish: our tokenizer stems and drops stopwords for ENGLISH. A
//      Portuguese page would become a pile of unstemmed words that match
//      English queries by accident ("de", "por") and pollute BM25's stats.
//   2. spam: commercial pages that exist to sell ("Marketing Agency in
//      Chicago", "Earn $50-$200 a Day"), found on open platforms like Medium.
//
// Skipping here instead of deleting means nothing is lost: change a rule and
// rebuild the index, and the pages come back. Both rules are heuristics, so
// they are tuned for PRECISION: wrongly hiding a good article is worse than
// letting one spam page through. The numbers below come from measuring the
// real corpus (3,525 Wikipedia + 992 Medium pages, 2026-11-15): 0 Wikipedia
// pages are skipped; every skipped Medium page was checked by hand.

import { foldText, languageProfile } from "../shared/tokenize.js";

// Under this many words a page is too short to judge its language reliably
// (a 30-word recipe card can have 0 function words by chance).
export const MIN_WORDS_TO_JUDGE = 80;
// Mostly non-Latin letters (Arabic, Hindi, Chinese...) = not English.
export const MAX_NON_LATIN = 0.5;
// Latin-script foreign text: other languages' function words must be both
// frequent AND more frequent than English ones. Measured on our corpus:
// foreign Medium posts have a foreign share of 0.11-0.34; on Wikipedia the
// highest is 0.104 ("Salve, Oh Patria", an article quoting Spanish anthem
// lyrics), which is kept because its English share (0.198) is higher.
// Tables (e.g. GDP lists) have both shares near 0 and are kept too.
export const MIN_FOREIGN_SHARE = 0.08;

/**
 * @param {string} text page body text
 * @returns {boolean} true if the page looks like it is NOT in English
 */
export function looksNotEnglish(text) {
  const p = languageProfile(text);
  if (p.words < MIN_WORDS_TO_JUDGE) return false; // can't tell: keep it
  if (p.nonLatin > MAX_NON_LATIN) return true;
  return p.foreign >= MIN_FOREIGN_SHARE && p.foreign > p.english;
}

// Each rule is one recognisable spam pattern in the TITLE, matched on folded
// (lowercase, accent-free) text. Named, so a human can check which rule fired.
// Titles only: a body-phrase rule ("contact us", "our services"...) was tried
// and dropped, because on the real corpus it found nothing the title rules
// missed, and its only own hits were wrong: an article QUOTING example calls
// to action, and "price your services" (which contains "our services").
export const SPAM_TITLE_RULES = [
  // Selling an agency's services, but not articles ABOUT starting one.
  ["agency-for-hire", /^(?!.*\b(start|starting|run|running|build|building) an? ).*\b(marketing|seo|advertising|ppc|branding|web design) (agency|agencies|company|services|solutions)\b/],
  ["income-claim", /\b(earn|make|making) (your first )?\$?\d[\d,]*(\s*[-–]\s*\$?\d[\d,]*)?\b|\$\d[\d,]*\s*[-–]\s*\$?\d[\d,]*\s*(\/|a |per )\s*(day|week|month)\b|\bmake money online\b|\bpassive income\b|\bwork(ing)? from home\b/],
  ["software-download", /\bdownload\b.*\b(full (setup|version)|crack|keygen|serial key|latest version)\b/],
  ["affiliate-review", /\breview( 20\d\d)?\s*:?\s*(is|can) (this|it)\b|\bworth buying\b/],
  ["shop-domain", /\bshop\b.*\b[a-z0-9-]+\.(com|eu|in|net|co|shop)\b/],
  ["regulated-goods", /\b(cbd|casino|betting|escort|viagra)\b/],
];

/**
 * Which spam rules a title triggers (empty array = not spam).
 * @param {string} title
 * @returns {string[]} rule names, e.g. ["agency-for-hire", "regulated-goods"]
 */
export function spamSignals(title) {
  const t = foldText(title);
  return SPAM_TITLE_RULES.filter(([, re]) => re.test(t)).map(([name]) => name);
}

/**
 * The indexer's verdict for one page.
 * @returns {null | "notEnglish" | "spam"} null = index it
 */
export function qualityVerdict(title, text) {
  if (looksNotEnglish(text)) return "notEnglish";
  if (spamSignals(title).length > 0) return "spam";
  return null;
}
