"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }
  return (
    <Button size="sm" variant="outline" onClick={() => void copy()}>
      {done ? <Check /> : <Copy />}
      {done ? "Copied" : label}
    </Button>
  );
}
