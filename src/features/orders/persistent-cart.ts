"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore, type SetStateAction } from "react";
import { clearPurchasedSelection, decodeCartField } from "./cart-storage";
const fallback = new Map<string, string>();
const eventName = "evento-brasil-cart-change";
function subscribe(onChange: () => void) { window.addEventListener("storage", onChange); window.addEventListener(eventName, onChange); return () => { window.removeEventListener("storage", onChange); window.removeEventListener(eventName, onChange); }; }
function read(key: string) { try { return window.localStorage.getItem(key); } catch { return fallback.get(key) ?? null; } }
/** Persists only ticket selection; no passwords, CPF, DOB or address enter browser storage. */
export function usePersistentCartState<T>(eventId: string, field: string, initial: T): [T, (value: SetStateAction<T>) => void] {
  const key = `eb-cart:${eventId}:${field}`;
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), () => null);
  const value = useMemo(() => decodeCartField(field, snapshot, initial), [field, snapshot, initial]);
  const setValue = (next: SetStateAction<T>) => {
    const current = decodeCartField(field, read(key), initial);
    const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
    const serialized = JSON.stringify(resolved);
    try { window.localStorage.setItem(key, serialized); } catch { fallback.set(key, serialized); }
    window.dispatchEvent(new Event(eventName));
  };
  return [value, setValue];
}

/** Clear only the completed cart, never a newer selection for the same event. */
export function ClearPurchasedCart({ eventId, idempotencyKey }: { eventId: string; idempotencyKey: string }) {
  useEffect(() => {
    try { clearPurchasedSelection(window.localStorage, eventId, idempotencyKey); } catch { clearPurchasedSelection({ getItem: (key) => fallback.get(key) ?? null, removeItem: (key) => { fallback.delete(key); } }, eventId, idempotencyKey); }
    window.dispatchEvent(new Event(eventName));
  }, [eventId, idempotencyKey]);
  return null;
}
