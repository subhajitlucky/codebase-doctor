export function parseNpmPackJson(output) {
  const candidateStarts = [...output.matchAll(/^\[/gm)]
    .map((match) => match.index)
    .filter((index) => index !== undefined)
    .reverse();

  for (const start of candidateStarts) {
    try {
      const parsed = JSON.parse(output.slice(start).trim());
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Earlier output may contain non-JSON lines beginning with `[`. Keep looking.
    }
  }

  throw new SyntaxError("npm pack did not emit a JSON array.");
}
