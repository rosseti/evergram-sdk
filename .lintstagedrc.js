// Generated file, excluded from lint (see .oxlintrc.json ignorePatterns) —
// oxlint errors with "No files found to lint" if it's the only staged match.
const GENERATED = "src/proto/evergram.ts";

module.exports = {
  "*.{ts,tsx,js,jsx,json,md}": ["prettier --write"],
  "*.{ts,tsx}": (filenames) => {
    const files = filenames.filter((f) => !f.endsWith(GENERATED));
    return files.length ? [`oxlint ${files.join(" ")}`] : [];
  },
};
