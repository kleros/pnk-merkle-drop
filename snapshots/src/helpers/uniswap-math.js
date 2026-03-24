// Uniswap V3/V4 concentrated-liquidity math via the official SDK.
// Uses TickMath + SqrtPriceMath from @uniswap/v3-sdk (same math used by V4 SDK and the Uniswap frontend).
// Source: https://github.com/Uniswap/sdks/tree/main/sdks/v3-sdk/src/utils

import { TickMath, SqrtPriceMath } from "@uniswap/v3-sdk";
import JSBI from "jsbi";

/**
 * Compute the token amounts held by a concentrated-liquidity position.
 * Equivalent to Solidity's LiquidityAmounts.getAmountsForLiquidity().
 *
 * @param {BigInt} sqrtPriceX96 - Current pool sqrt price (Q64.96)
 * @param {number} tickLower - Position's lower tick
 * @param {number} tickUpper - Position's upper tick
 * @param {BigInt} liquidity - Position's liquidity
 * @returns {{ amount0: BigInt, amount1: BigInt }}
 */
export function getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity) {
  const sqrtRatioX96 = JSBI.BigInt(sqrtPriceX96.toString());
  const sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
  const sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);
  const liq = JSBI.BigInt(liquidity.toString());

  let amount0 = JSBI.BigInt(0);
  let amount1 = JSBI.BigInt(0);

  if (JSBI.lessThanOrEqual(sqrtRatioX96, sqrtRatioAX96)) {
    amount0 = SqrtPriceMath.getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, liq, false);
  } else if (JSBI.lessThan(sqrtRatioX96, sqrtRatioBX96)) {
    amount0 = SqrtPriceMath.getAmount0Delta(sqrtRatioX96, sqrtRatioBX96, liq, false);
    amount1 = SqrtPriceMath.getAmount1Delta(sqrtRatioAX96, sqrtRatioX96, liq, false);
  } else {
    amount1 = SqrtPriceMath.getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, liq, false);
  }

  return {
    amount0: BigInt(amount0.toString()),
    amount1: BigInt(amount1.toString()),
  };
}
