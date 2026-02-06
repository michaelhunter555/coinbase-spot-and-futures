import fs from "node:fs";
import path from "node:path";

export type PositionState = {
  positionExists: boolean;
  acquiredPrice?: number;
  acquiredCostQuote?: number;
  lastOrderId?: string;
  lastUpdatedAt: string;
};

export class PositionStore {
  private filepath: string;

  constructor(opts: { dataDir: string; name: string }) {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.filepath = path.join(opts.dataDir, `${opts.name}.position.json`);
  }

  read(): PositionState {
    try {
      const raw = fs.readFileSync(this.filepath, "utf8");
      const parsed = JSON.parse(raw) as PositionState;
      if (typeof parsed.positionExists !== "boolean") throw new Error("Invalid position file");
      return parsed;
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn("PositionStore read failed, starting fresh:", e?.message ?? e);
      }
      return { positionExists: false, lastUpdatedAt: new Date().toISOString() };
    }
  }

  write(state: Omit<PositionState, "lastUpdatedAt">) {
    const next: PositionState = { ...state, lastUpdatedAt: new Date().toISOString() };
    // Avoid serializing explicit `undefined` values (helps with exactOptionalPropertyTypes)
    const pruned = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
    fs.writeFileSync(this.filepath, JSON.stringify(pruned, null, 2));
  }
}


