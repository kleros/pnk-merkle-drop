import fetch from "node-fetch";
import { retry } from "./retry.js";

const FETCH_TIMEOUT_MS = 60000;

/**
 * Fetches a JSON resource with retries, a timeout and status checking.
 *
 * @param {string} url The URL to fetch.
 * @param {Object} [options] Extra node-fetch options (method, headers, body...).
 * @param {Function} [options.validate] Called with the parsed JSON, inside the retry loop. Throw to
 *   reject a response that is well-formed JSON but still a failure — e.g. errors reported in-band
 *   with a 200 status — so it gets retried like any other transient error.
 * @returns {Promise<any>} The parsed JSON response.
 */
export const fetchJson = (url, { validate, ...options } = {}) =>
  retry(async () => {
    const method = options.method ?? "GET";
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...options });
    if (!response.ok) {
      throw new Error(`${method} ${url} responded with ${response.status} ${response.statusText}`);
    }
    let json;
    try {
      json = await response.json();
    } catch (err) {
      // Some hosts answer an unknown path with 200 and an HTML page rather than a 404 — SPAs like
      // court.kleros.io do this — so a moved file surfaces here instead of in the status check above.
      throw new Error(`${method} ${url} did not respond with JSON (${err.message})`);
    }
    validate?.(json);
    return json;
  });
