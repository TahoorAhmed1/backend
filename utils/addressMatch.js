// ---------- Address cross-check ----------

const ADDRESS_STOPWORDS = new Set([
  "flat",
  "floor",
  "house",
  "street",
  "st",
  "no",
  "number",
  "near",
  "phase",
  "block",
  "society",
  "road",
  "karachi",
  "apartment",
  "apartments",
  "building",
  "plot",
  "the",
  "of",
  "and",
  "view",
  "town",
  "city",
  "sector",
  "area",
  "opposite",
  "behind",
  "infront",
  "front",
  "gali",
  "commercial",
]);


const normalizeAddressTokens = (raw) =>
  new Set(
    String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !ADDRESS_STOPWORDS.has(t)),
  );


const ADDRESS_MATCH_THRESHOLD = 0.15;

const analyzeAddressMatch = (sheetAddress, employee) => {
  const sheetTokens = normalizeAddressTokens(sheetAddress);
  if (sheetTokens.size === 0) {
    return { isMatch: true, score: null, reason: null };
  }

  const taxonomyTokens = normalizeAddressTokens(
    [employee.area?.name, employee.subArea?.name, employee.block?.name]
      .filter(Boolean)
      .join(" "),
  );
  const masterTokens = normalizeAddressTokens(employee.address);
  const compareTokens = new Set([...masterTokens, ...taxonomyTokens]);
  if (compareTokens.size === 0) {
    return { isMatch: true, score: null, reason: null };
  }

  const intersection = [...sheetTokens].filter((t) => compareTokens.has(t));
  const union = new Set([...sheetTokens, ...compareTokens]);
  const score = intersection.length / union.size;
  if (score >= ADDRESS_MATCH_THRESHOLD) {
    return { isMatch: true, score, reason: null };
  }

  return {
    isMatch: false,
    score,
    reason: `Sheet address ("${sheetAddress}") shares almost nothing with this employee's master-data address/area`,
  };
};


module.exports = {
  ADDRESS_STOPWORDS,
  normalizeAddressTokens,
  ADDRESS_MATCH_THRESHOLD,
  analyzeAddressMatch,
};
