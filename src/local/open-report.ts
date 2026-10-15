import { constants as fsConstants } from "node:fs";
import { lstat, open as openFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import openUrl from "open";

import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";

export type LocalReportOpener = (path: string) => Promise<void>;

export async function openLocalReport(path: string): Promise<void> {
  let handle;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("the report path is not a regular file");
    }
    const noFollow =
      process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number"
        ? fsConstants.O_NOFOLLOW
        : 0;
    handle = await openFile(path, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(opened, metadata)) {
      throw new Error("the report path changed while it was being opened");
    }
    const resolved = await realpath(path);
    const resolvedMetadata = await lstat(resolved);
    if (!resolvedMetadata.isFile() || !sameFileIdentity(resolvedMetadata, opened)) {
      throw new Error("the resolved report path changed while it was being opened");
    }
    await openUrl(pathToFileURL(resolved).toString(), { wait: false });
  } catch (cause) {
    throw new AwError({
      code: "LOCAL_REPORT_OPEN_FAILED",
      category: "local",
      message: "Could not open the local HTML report. Open the displayed report path manually.",
      cause
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
