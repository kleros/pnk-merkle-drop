// The variables whose values reach a chain, a subgraph or IPFS. The RPC and subgraph URLs carry API keys,
// and ethers 5 puts a failing request's URL into its error messages.
// The self-test keeps the same variables from the test suite. test/redact.test.js checks that they cover
// every variable .env.example defines.
export const SECRET_ENV = /^(ALCHEMY_|SUBGRAPH_|FILEBASE_)/;

/**
 * Replaces the value of each such variable in `text` with the variable's name, e.g. `$ALCHEMY_GNOSIS_RPC`,
 * so that an error can be printed, and shared, without the keys in it.
 */
export const redact = (text) =>
  Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV.test(name) && value && value.length >= 8)
    // longest first, so that a value containing another one is replaced whole
    .sort(([, a], [, b]) => b.length - a.length)
    .reduce((out, [name, value]) => out.split(value).join(`$${name}`), String(text));
