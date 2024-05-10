import path from "path";
import fs from "fs";
import dotenv from "dotenv";

import { File, FilebaseClient } from "@filebase/client";
dotenv.config();

// The API-TOKEN defines in which bucket is going to be stored
const filebase = new FilebaseClient({ token: process.env.FILEBASE_TOKEN ?? "" });

export const fileToIpfs = async (filePath) => {
    const content = await fs.promises.readFile(filePath);
    const mimeType = 'application/json';
    const fileName = path.basename(filePath);
    const cid = await filebase.storeDirectory([new File([content], `${fileName}`, { type: mimeType })]);
    console.log(cid);
    return cid;
  };