"use client";

import React from "react";
import { TradesProvider } from "../contexts/TradesContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return <TradesProvider>{children}</TradesProvider>;
}


