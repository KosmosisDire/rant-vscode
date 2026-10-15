import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The text of a file under test/fixtures. */
export function fixture(name: string): string {
  return readFileSync(path.join(here, "fixtures", name), "utf8");
}
