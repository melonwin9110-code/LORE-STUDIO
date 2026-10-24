"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, Trash2, UserRound } from "lucide-react";
import type { Character } from "@/lib/types";

export function PortraitEditor({ character, readOnly, onChanged }: { character?: Character; readOnly?: boolean; onChanged: (url: string | null) => void | Promise<void> }) {
  const [url, setUrl] = useState(character?.portraitUrl || null);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  async function submit(remove = false) {
    if (!character || (!remove && !file)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/characters/${character.id}/portrait`, {
        method: remove ? "DELETE" : "PUT", credentials: "same-origin",
        ...(remove ? {} : { headers: { "Content-Type": file!.type }, body: file! }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Не удалось сохранить портрет");
      const saved = remove ? null : String(result.portraitUrl);
      setUrl(saved); setFile(null); setPreview(null); if (input.current) input.current.value = "";
      await onChanged(saved);
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить портрет"); }
    finally { setBusy(false); }
  }
  const shown = preview || url;
  return <section className="portrait-editor" aria-label="Портрет персонажа">
    <div className="portrait-editor-preview">{shown ? <Image src={shown} alt={`Портрет ${character?.name || "персонажа"}`} fill unoptimized sizes="120px" /> : <UserRound size={38} strokeWidth={1.2} />}</div>
    <div className="portrait-editor-body"><strong>Свой портрет</strong><p>{character ? "PNG, JPEG или WebP · до 5 МБ. Портрет общий для всех версий этого персонажа." : "Сначала сохраните персонажа, затем добавьте собственное изображение."}</p>
      {character && <><label className="portrait-file-label"><span><ImagePlus size={14} />Выбрать изображение</span><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Изображение персонажа" disabled={busy || readOnly} onChange={(event) => {
        const selected = event.target.files?.[0]; setError("");
        if (!selected) return;
        if (!["image/png", "image/jpeg", "image/webp"].includes(selected.type)) { setError("Выберите PNG, JPEG или WebP"); setFile(null); setPreview(null); event.target.value = ""; return; }
        if (selected.size > 5 * 1024 * 1024) { setError("Размер изображения не должен превышать 5 МБ"); setFile(null); setPreview(null); event.target.value = ""; return; }
        setFile(selected); setPreview(URL.createObjectURL(selected));
      }} /></label><div className="portrait-editor-actions">{file && <button type="button" className="button primary" disabled={busy || readOnly} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={14} /> : <ImagePlus size={14} />}Сохранить портрет</button>}{(url || preview) && <button type="button" className="button danger-quiet" disabled={busy || readOnly} onClick={() => { if (url) void submit(true); else { setFile(null); setPreview(null); if (input.current) input.current.value = ""; } }}><Trash2 size={14} />Удалить портрет</button>}</div></>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  </section>;
}
