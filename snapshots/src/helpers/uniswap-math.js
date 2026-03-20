// Shared Uniswap V3/V4 math — TickMath + LiquidityAmounts
// Ported from:
//   https://github.com/Uniswap/v4-core/blob/main/src/libraries/TickMath.sol
//   https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/LiquidityAmounts.sol

const Q96 = 1n << 96n;

// TickMath.getSqrtRatioAtTick — returns sqrtPriceX96 as BigInt
export function getSqrtRatioAtTick(tick) {
  const absTick = Math.abs(tick);
  if (absTick > 887272) throw new Error(`Tick ${tick} out of range`);

  let ratio = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;

  // Q128.128 → Q64.96, rounding up
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// LiquidityAmounts — compute token amounts from a concentrated liquidity position
function getAmount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return ((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB / sqrtA;
}

function getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

export function getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity) {
  let sqrtA = getSqrtRatioAtTick(tickLower);
  let sqrtB = getSqrtRatioAtTick(tickUpper);
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];

  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtPriceX96 <= sqrtA) {
    amount0 = getAmount0ForLiquidity(sqrtA, sqrtB, liquidity);
  } else if (sqrtPriceX96 < sqrtB) {
    amount0 = getAmount0ForLiquidity(sqrtPriceX96, sqrtB, liquidity);
    amount1 = getAmount1ForLiquidity(sqrtA, sqrtPriceX96, liquidity);
  } else {
    amount1 = getAmount1ForLiquidity(sqrtA, sqrtB, liquidity);
  }
  return { amount0, amount1 };
}
