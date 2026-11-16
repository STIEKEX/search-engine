import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksNotEnglish, MIN_WORDS_TO_JUDGE, qualityVerdict, spamSignals } from "../../indexer/quality.js";
import { languageProfile } from "../../shared/tokenize.js";

// Long enough to be judged (>= MIN_WORDS_TO_JUDGE words).
const long = (sentence) => `${sentence} `.repeat(Math.ceil(MIN_WORDS_TO_JUDGE / sentence.split(" ").length) + 1);

describe("languageProfile", () => {
  test("the worked examples from the comment", () => {
    const en = languageProfile("The cat sat on the mat");
    assert.equal(en.words, 6);
    assert.equal(en.english, 0.5); // the, on, the
    assert.equal(en.foreign, 0);
    const es = languageProfile("El gato duerme en la casa");
    assert.equal(es.english, 0);
    assert.equal(es.foreign, 0.5); // el, en, la
  });

  test("nonLatin is the share of letters from other scripts", () => {
    assert.equal(languageProfile("hello").nonLatin, 0);
    assert.equal(languageProfile("مرحبا").nonLatin, 1);
    assert.equal(languageProfile("ab مر").nonLatin, 0.5);
  });

  test("empty text gives zeros, not NaN", () => {
    assert.deepEqual(languageProfile(""), { words: 0, english: 0, foreign: 0, nonLatin: 0 });
    assert.deepEqual(languageProfile(null), { words: 0, english: 0, foreign: 0, nonLatin: 0 });
  });
});

describe("looksNotEnglish", () => {
  test("English prose is English", () => {
    assert.equal(looksNotEnglish(long("The engineers wrote a short report about the system and its users.")), false);
  });

  test("Spanish, Portuguese, Indonesian and French prose are not", () => {
    assert.equal(looksNotEnglish(long("El sistema de pagos es una parte importante para los usuarios de la tienda.")), true);
    assert.equal(looksNotEnglish(long("Uma ideia não precisa de um time grande para ser lançada com sucesso.")), true);
    assert.equal(looksNotEnglish(long("Saya tidak tahu apa yang akan terjadi dengan kita dan dunia ini.")), true);
    assert.equal(looksNotEnglish(long("Le nouvel épisode est disponible pour les auditeurs et nous sommes ravis.")), true);
  });

  test("Arabic or Chinese script is not English", () => {
    assert.equal(looksNotEnglish(long("الخوف والأمل في حياة الإنسان اليومية")), true);
    assert.equal(looksNotEnglish(long("这个 点子 在 我 手机 备忘录 里 躺 了 三 年")), true);
  });

  test("a TABLE of names and numbers is kept: few function words of ANY language", () => {
    // Like Wikipedia's "List of countries by GDP": almost no "the"/"of", but English.
    const table = long("Germany 4,525 France 3,031 Italy 2,255 Spain 1,580 Poland 842 Netherlands 1,118");
    assert.equal(languageProfile(table).english, 0);
    assert.equal(looksNotEnglish(table), false);
  });

  test("an English article quoting some Spanish stays English (English share is higher)", () => {
    const text = long("The anthem of the country was written in the old days and its first line says que viva la patria.");
    assert.equal(looksNotEnglish(text), false);
  });

  test("too short to judge: kept", () => {
    assert.equal(looksNotEnglish("Selamat ulang tahun dan semoga bahagia"), false);
  });
});

describe("spamSignals", () => {
  test("real spam titles from the Medium import, one per rule", () => {
    assert.deepEqual(spamSignals("Affordable MCA Marketing Agency in Chicago Focused on High ROI Campaigns"), ["agency-for-hire"]);
    assert.deepEqual(spamSignals("Make Money Online Guide: 10 Beginner-Friendly Ways to Earn $50–$200 a Day"), ["income-claim"]);
    assert.deepEqual(spamSignals("CPA Marketing Training for Beginners: How to Build a $50-$200/Day Affiliate Business"), ["income-claim"]);
    assert.deepEqual(spamSignals("Prime Tool V9.0 Download Full Setup (Latest Version) 2027"), ["software-download"]);
    assert.deepEqual(spamSignals("CineMill Creator Review 2026: Can This AI Video Creation Tool Help You"), ["affiliate-review"]);
    assert.deepEqual(spamSignals("Clear Skin Starts Here: Shop Smart Skincare at SkinEssential.eu"), ["shop-domain"]);
    assert.deepEqual(spamSignals("Expert CBD SEO Solutions for Higher Search Rankings"), ["agency-for-hire", "regulated-goods"]);
  });

  test("honest titles near the rules are NOT spam (false positives we checked)", () => {
    for (const title of [
      "Is Starting a Digital Marketing Agency in 2026 Still a Good Idea?", // about agencies, not selling one
      "How Content Marketing Helps Businesses Build Brand Awareness",
      "Design a Payment System — The System Design Series",
      "I Was Made Redundant After 30 Years. It Became the Start of My Real Career.",
      "A Review of the Year in Rust", // "review" alone is fine
      "Merge Sort Algorithm Explained: Recursive vs Iterative",
    ]) {
      assert.deepEqual(spamSignals(title), [], title);
    }
  });
});

test("qualityVerdict: language is checked first, then spam, else null (index it)", () => {
  const english = long("The team shipped the feature and wrote down what they learned from it.");
  assert.equal(qualityVerdict("Lessons from shipping", english), null);
  assert.equal(qualityVerdict("How to Earn $50-$200 a Day", english), "spam");
  assert.equal(qualityVerdict("How to Earn $50-$200 a Day", long("Saya tidak tahu apa yang akan terjadi dengan kita.")), "notEnglish");
});
