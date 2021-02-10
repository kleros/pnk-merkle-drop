import AWS from "aws-sdk";
import crypto from "crypto";
import bigNumberJsonReplacer from "./helpers/big-number-json-replacer.js";

const BUCKET = "pnk-airdrop-snapshots";
const FILE_NAME_TEMPLATE = "{{prefix}}snapshot-{{period}}.json";
const URL_TEMPLATE = `https://${BUCKET}.s3.us-east-2.amazonaws.com/{{key}}`;

const prefixByChainId = {
  42: "kovan-",
  1: "",
};

const s3 = new AWS.S3();

export default async function storeSnapshot({ chainId, period, content }) {
  const key = parseTemplate(FILE_NAME_TEMPLATE, {
    prefix: prefixByChainId[chainId],
    period,
  });
  const url = parseTemplate(URL_TEMPLATE, { key });

  if (await checkObjectExists(key)) {
    throw new Error(`Snapshot #${period} already created at: ${url}`);
  }
  await putObject(key, content);

  return url;
}

async function putObject(key, content) {
  const body = JSON.stringify(content, bigNumberJsonReplacer);

  return await s3
    .putObject({
      Bucket: BUCKET,
      Key: key,
      ACL: "public-read",
      ContentType: "application/json",
      Body: body,
      ContentMD5: md5Digest(body),
    })
    .promise();
}

async function checkObjectExists(key) {
  try {
    await s3
      .headObject({
        Bucket: BUCKET,
        Key: key,
      })
      .promise();
    return true;
  } catch {
    return false;
  }
}

function parseTemplate(template, data) {
  return Object.entries(data).reduce(
    (result, [key, value]) => result.replace(new RegExp(`{{${key}}}`, "g"), value),
    template
  );
}

function md5Digest(content) {
  return crypto.createHash("md5").update(content, "utf8").digest("base64");
}
