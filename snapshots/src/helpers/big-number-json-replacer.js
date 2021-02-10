import { BigNumber } from "ethers";

export default function bigNumberJsonReplacer(_, value) {
  return value && value.type === "BigNumber" ? BigNumber.from(value).toString() : value;
}
