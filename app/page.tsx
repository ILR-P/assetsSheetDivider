"use client";

import {
  ChangeEvent,
  MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import NextImage from "next/image";
import JSZip from "jszip";

const DEFAULT_TILE_SIZE = 16;
const LOCAL_STORAGE_KEY = "sprite-slicer-saved-slices-v1";
const FURNITURE_TYPES = [
  "sofa",
  "chair",
  "drawer",
  "desk",
  "bookshelf",
  "rug",
  "miscelanious",
] as const;

type FurnitureType = (typeof FURNITURE_TYPES)[number];

type Sheet = {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
};

type Slice = {
  id: string;
  name: string;
  category?: FurnitureType;
  sheetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: string;
};

type DragSelection = {
  sheetId: string;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
};

type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function safeFileName(input: string) {
  const normalized = input.trim().replace(/[\\/:*?"<>|]+/g, "-");
  return normalized.length > 0 ? normalized : "sprite";
}

function inferCategoryFromName(name: string): FurnitureType | null {
  const lower = name.toLowerCase();
  for (const type of FURNITURE_TYPES) {
    if (lower.startsWith(`${type}_`)) {
      return type;
    }
  }
  return null;
}

function formatAutoName(type: FurnitureType, currentCount: number) {
  return `${type}_${String(currentCount + 1).padStart(3, "0")}`;
}

function getCellFromMouse(
  event: MouseEvent<HTMLDivElement>,
  sheet: Sheet,
  zoom: number,
  tileSize: number,
) {
  const rect = event.currentTarget.getBoundingClientRect();
  const xPx = (event.clientX - rect.left) / zoom;
  const yPx = (event.clientY - rect.top) / zoom;
  const maxCol = Math.max(Math.ceil(sheet.width / tileSize) - 1, 0);
  const maxRow = Math.max(Math.ceil(sheet.height / tileSize) - 1, 0);

  const col = Math.min(Math.max(Math.floor(xPx / tileSize), 0), maxCol);
  const row = Math.min(Math.max(Math.floor(yPx / tileSize), 0), maxRow);

  return { col, row };
}

function selectionToRect(
  selection: DragSelection,
  tileSize: number,
): Rectangle {
  const leftCol = Math.min(selection.startCol, selection.endCol);
  const rightCol = Math.max(selection.startCol, selection.endCol);
  const topRow = Math.min(selection.startRow, selection.endRow);
  const bottomRow = Math.max(selection.startRow, selection.endRow);

  return {
    x: leftCol * tileSize,
    y: topRow * tileSize,
    width: (rightCol - leftCol + 1) * tileSize,
    height: (bottomRow - topRow + 1) * tileSize,
  };
}

function sizeFolder(width: number, height: number) {
  return `${width}x${height}`;
}

function createImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to create PNG blob"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

function downloadBlob(blob: Blob, fileName: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(href);
}

export default function Home() {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [savedSlices, setSavedSlices] = useState<Slice[]>([]);
  const [drag, setDrag] = useState<DragSelection | null>(null);
  const [draft, setDraft] = useState<DragSelection | null>(null);
  const [selectedType, setSelectedType] = useState<FurnitureType>("chair");
  const [sliceName, setSliceName] = useState("chair_001");
  const [isManualName, setIsManualName] = useState(false);
  const [zoom, setZoom] = useState(2);
  const [tileSize, setTileSize] = useState(DEFAULT_TILE_SIZE);
  const [xOffset, setXOffset] = useState(0);
  const [yOffset, setYOffset] = useState(0);
  const [status, setStatus] = useState(
    "Upload your sprite sheets to start slicing.",
  );
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Slice[];
      if (Array.isArray(parsed)) {
        setSavedSlices(parsed);
      }
    } catch {
      setStatus("Could not restore saved slices from local storage.");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(savedSlices));
  }, [savedSlices]);

  useEffect(() => {
    return () => {
      sheets.forEach((sheet) => URL.revokeObjectURL(sheet.url));
    };
  }, [sheets]);

  const currentRect = useMemo(() => {
    if (!draft) {
      return null;
    }
    return selectionToRect(draft, tileSize);
  }, [draft, tileSize]);

  const currentSheet = useMemo(
    () => sheets.find((sheet) => sheet.id === draft?.sheetId) ?? null,
    [draft?.sheetId, sheets],
  );

  const currentSourceRect = useMemo(() => {
    if (!currentRect || !currentSheet) {
      return null;
    }

    const maxX = Math.max(currentSheet.width - currentRect.width, 0);
    const maxY = Math.max(currentSheet.height - currentRect.height, 0);
    return {
      ...currentRect,
      x: Math.min(Math.max(currentRect.x - xOffset, 0), maxX),
      y: Math.min(Math.max(currentRect.y - yOffset, 0), maxY),
    };
  }, [currentRect, currentSheet, xOffset, yOffset]);

  const groupedCounts = useMemo(() => {
    return savedSlices.reduce<Record<string, number>>((acc, slice) => {
      const key = sizeFolder(slice.width, slice.height);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }, [savedSlices]);

  const selectedTypeCount = useMemo(() => {
    return savedSlices.filter((slice) => {
      if (slice.category) {
        return slice.category === selectedType;
      }
      return inferCategoryFromName(slice.name) === selectedType;
    }).length;
  }, [savedSlices, selectedType]);

  const suggestedName = useMemo(
    () => formatAutoName(selectedType, selectedTypeCount),
    [selectedType, selectedTypeCount],
  );

  useEffect(() => {
    if (!isManualName) {
      setSliceName(suggestedName);
    }
  }, [isManualName, suggestedName]);

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const entries = await Promise.all(
      Array.from(files).map(async (file): Promise<Sheet | null> => {
        if (file.type !== "image/png") {
          return null;
        }

        const url = URL.createObjectURL(file);
        try {
          const image = await createImage(url);
          return {
            id: crypto.randomUUID(),
            name: file.name,
            url,
            width: image.naturalWidth,
            height: image.naturalHeight,
          };
        } catch {
          URL.revokeObjectURL(url);
          return null;
        }
      }),
    );

    const validEntries = entries.filter(
      (entry): entry is Sheet => entry !== null,
    );
    if (validEntries.length === 0) {
      setStatus("No valid PNG files were loaded.");
      return;
    }

    setSheets((previous) => {
      previous.forEach((sheet) => URL.revokeObjectURL(sheet.url));
      return validEntries;
    });

    setSavedSlices((previous) =>
      previous.filter((slice) =>
        validEntries.some((sheet) => sheet.id === slice.sheetId),
      ),
    );
    imageCacheRef.current.clear();
    setDraft(null);
    setDrag(null);
    setStatus(
      `Loaded ${validEntries.length} sheet(s). Drag on a sheet to select tiles.`,
    );
  }

  function startDrag(event: MouseEvent<HTMLDivElement>, sheet: Sheet) {
    const { col, row } = getCellFromMouse(event, sheet, zoom, tileSize);
    const nextSelection: DragSelection = {
      sheetId: sheet.id,
      startCol: col,
      startRow: row,
      endCol: col,
      endRow: row,
    };
    setDrag(nextSelection);
    setDraft(nextSelection);
  }

  function updateDrag(event: MouseEvent<HTMLDivElement>, sheet: Sheet) {
    if (!drag || drag.sheetId !== sheet.id) {
      return;
    }
    const { col, row } = getCellFromMouse(event, sheet, zoom, tileSize);
    const nextSelection: DragSelection = {
      ...drag,
      endCol: col,
      endRow: row,
    };
    setDrag(nextSelection);
    setDraft(nextSelection);
  }

  function stopDrag() {
    if (!drag) {
      return;
    }
    setDrag(null);
  }

  function saveCurrentSelection() {
    if (!draft || !currentSourceRect || !currentSheet) {
      return;
    }

    const newSlice: Slice = {
      id: crypto.randomUUID(),
      name: safeFileName(sliceName),
      category: selectedType,
      sheetId: currentSheet.id,
      x: currentSourceRect.x,
      y: currentSourceRect.y,
      width: currentSourceRect.width,
      height: currentSourceRect.height,
      createdAt: new Date().toISOString(),
    };

    setSavedSlices((previous) => [newSlice, ...previous]);
    setIsManualName(false);
    setStatus(
      `Saved ${newSlice.name} from ${currentSheet.name} (${newSlice.width}x${newSlice.height}).`,
    );
  }

  function removeSlice(id: string) {
    setSavedSlices((previous) => previous.filter((slice) => slice.id !== id));
  }

  async function exportSlices() {
    if (savedSlices.length === 0) {
      setStatus("No slices to export yet.");
      return;
    }

    try {
      const zip = new JSZip();
      const duplicateCounter = new Map<string, number>();

      for (const slice of savedSlices) {
        const sheet = sheets.find((entry) => entry.id === slice.sheetId);
        if (!sheet) {
          continue;
        }

        let image = imageCacheRef.current.get(sheet.id);
        if (!image) {
          image = await createImage(sheet.url);
          imageCacheRef.current.set(sheet.id, image);
        }

        const canvas = document.createElement("canvas");
        canvas.width = slice.width;
        canvas.height = slice.height;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Could not prepare a 2D canvas context.");
        }

        context.drawImage(
          image,
          slice.x,
          slice.y,
          slice.width,
          slice.height,
          0,
          0,
          slice.width,
          slice.height,
        );

        const blob = await canvasBlob(canvas);
        const folder = sizeFolder(slice.width, slice.height);
        const baseName = safeFileName(slice.name);
        const duplicateKey = `${folder}/${baseName}`;
        const duplicateIndex = duplicateCounter.get(duplicateKey) ?? 0;
        duplicateCounter.set(duplicateKey, duplicateIndex + 1);

        const fileName =
          duplicateIndex === 0
            ? `${baseName}.png`
            : `${baseName}-${duplicateIndex + 1}.png`;

        zip.file(`${folder}/${fileName}`, blob);
      }

      zip.file(
        "manifest.json",
        JSON.stringify(
          {
            tileSize,
            xOffset,
            yOffset,
            generatedAt: new Date().toISOString(),
            slices: savedSlices,
          },
          null,
          2,
        ),
      );

      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, "sprite-slices.zip");
      setStatus("Export complete. Downloaded sprite-slices.zip");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown export failure";
      setStatus(`Export failed: ${message}`);
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#fef3c7,#e0f2fe_45%,#f8fafc)] px-4 py-8 text-slate-900 sm:px-6 lg:px-10">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="rounded-2xl border border-amber-200/80 bg-white/85 p-5 shadow-[0_10px_30px_-15px_rgba(15,23,42,0.45)] backdrop-blur">
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">
            Sprite Sheet Divider and Exporter
          </h1>
          <p className="mt-2 text-sm font-medium text-slate-700 sm:text-base">
            Upload your PNG sheets, drag to select rectangles snapped to tile
            size, save each slice by name, then export grouped folders by size.
          </p>
          <p className="mt-2 text-sm font-semibold text-slate-600">{status}</p>
        </header>

        <section className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <aside className="rounded-2xl border border-sky-200 bg-white/90 p-5 shadow-[0_8px_25px_-14px_rgba(2,132,199,0.65)]">
            <label className="block text-sm font-bold text-slate-700">
              Sprite sheets (PNG)
            </label>
            <input
              type="file"
              accept=".png,image/png"
              multiple
              onChange={handleFileUpload}
              className="mt-2 w-full cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />

            <label className="mt-4 block text-sm font-bold text-slate-700">
              Zoom ({zoom.toFixed(1)}x)
            </label>
            <input
              type="range"
              min={1}
              max={4}
              step={0.25}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="mt-2 w-full"
            />

            <label className="mt-4 block text-sm font-bold text-slate-700">
              Tile size (px)
            </label>
            <input
              type="number"
              min={1}
              max={512}
              step={1}
              value={tileSize}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (!Number.isFinite(nextValue)) {
                  return;
                }
                setTileSize(Math.min(Math.max(Math.round(nextValue), 1), 512));
              }}
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />

            <label className="mt-4 block text-sm font-bold text-slate-700">
              Image X offset (px)
            </label>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={-256}
                max={256}
                step={1}
                value={xOffset}
                onChange={(event) => setXOffset(Number(event.target.value))}
                className="w-full"
              />
              <input
                type="number"
                min={-2048}
                max={2048}
                step={1}
                value={xOffset}
                onChange={(event) => {
                  const nextValue = Number(event.target.value);
                  if (!Number.isFinite(nextValue)) {
                    return;
                  }
                  setXOffset(Math.round(nextValue));
                }}
                className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
              />
            </div>

            <label className="mt-4 block text-sm font-bold text-slate-700">
              Image Y offset (px)
            </label>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={-256}
                max={256}
                step={1}
                value={yOffset}
                onChange={(event) => setYOffset(Number(event.target.value))}
                className="w-full"
              />
              <input
                type="number"
                min={-2048}
                max={2048}
                step={1}
                value={yOffset}
                onChange={(event) => {
                  const nextValue = Number(event.target.value);
                  if (!Number.isFinite(nextValue)) {
                    return;
                  }
                  setYOffset(Math.round(nextValue));
                }}
                className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
              />
            </div>

            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
              <h2 className="text-sm font-black uppercase tracking-wide text-emerald-800">
                Draft Selection
              </h2>
              {draft && currentRect && currentSheet ? (
                <>
                  <p className="mt-2 text-sm font-medium text-emerald-950">
                    Sheet: {currentSheet.name}
                  </p>
                  <p className="text-sm text-emerald-900">
                    X:{currentRect.x} Y:{currentRect.y} W:{currentRect.width} H:
                    {currentRect.height}
                  </p>
                  {currentSourceRect && (
                    <p className="text-xs text-emerald-800">
                      Source after offset: X {currentSourceRect.x}, Y{" "}
                      {currentSourceRect.y}
                    </p>
                  )}
                  <label className="mt-3 block text-xs font-bold uppercase tracking-wide text-emerald-900">
                    Type
                  </label>
                  <select
                    value={selectedType}
                    onChange={(event) => {
                      setSelectedType(event.target.value as FurnitureType);
                      setIsManualName(false);
                    }}
                    className="mt-1 w-full rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm"
                  >
                    {FURNITURE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={sliceName}
                    onChange={(event) => {
                      setSliceName(event.target.value);
                      setIsManualName(true);
                    }}
                    placeholder="slice name"
                    className="mt-3 w-full rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm"
                  />
                  <p className="mt-2 text-xs text-emerald-900">
                    Suggested: {suggestedName}
                  </p>
                  <button
                    type="button"
                    onClick={saveCurrentSelection}
                    className="mt-3 w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white transition hover:bg-emerald-800"
                  >
                    Save Slice
                  </button>
                </>
              ) : (
                <p className="mt-2 text-sm text-emerald-900">
                  Drag over any sheet to create a draft.
                </p>
              )}
            </div>

            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-black uppercase tracking-wide text-amber-900">
                  Export Folders
                </h2>
                <button
                  type="button"
                  onClick={exportSlices}
                  className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white transition hover:bg-amber-800"
                >
                  Export ZIP
                </button>
              </div>
              <ul className="mt-3 space-y-1 text-sm text-amber-950">
                {Object.keys(groupedCounts).length > 0 ? (
                  Object.entries(groupedCounts)
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([size, count]) => (
                      <li
                        key={size}
                        className="flex items-center justify-between"
                      >
                        <span>{size}</span>
                        <span className="rounded bg-amber-100 px-2 py-0.5 font-semibold">
                          {count}
                        </span>
                      </li>
                    ))
                ) : (
                  <li>No folders yet. Save slices first.</li>
                )}
              </ul>
            </div>

            <div className="mt-5">
              <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">
                Saved Slices ({savedSlices.length})
              </h2>
              <ul className="mt-2 max-h-64 space-y-2 overflow-auto pr-1">
                {savedSlices.length > 0 ? (
                  savedSlices.map((slice) => {
                    const sheetName =
                      sheets.find((sheet) => sheet.id === slice.sheetId)
                        ?.name ?? "Unknown";
                    return (
                      <li
                        key={slice.id}
                        className="rounded-lg border border-slate-200 bg-white p-2 text-sm"
                      >
                        <div className="font-bold text-slate-900">
                          {slice.name}
                        </div>
                        <div className="text-slate-600">
                          Type:{" "}
                          {slice.category ??
                            inferCategoryFromName(slice.name) ??
                            "custom"}
                        </div>
                        <div className="text-slate-700">
                          {slice.width}x{slice.height} on {sheetName}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeSlice(slice.id)}
                          className="mt-2 rounded border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-50"
                        >
                          Delete
                        </button>
                      </li>
                    );
                  })
                ) : (
                  <li className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-600">
                    No saved slices.
                  </li>
                )}
              </ul>
            </div>
          </aside>

          <section className="space-y-5">
            {sheets.length > 0 ? (
              sheets.map((sheet) => {
                const savedForSheet = savedSlices.filter(
                  (slice) => slice.sheetId === sheet.id,
                );
                const draftRect =
                  draft?.sheetId === sheet.id
                    ? selectionToRect(draft, tileSize)
                    : null;

                return (
                  <article
                    key={sheet.id}
                    className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-[0_8px_20px_-14px_rgba(15,23,42,0.55)]"
                  >
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-lg font-black text-slate-900">
                        {sheet.name}
                      </h2>
                      <p className="text-sm font-semibold text-slate-700">
                        {sheet.width}x{sheet.height}px
                      </p>
                    </div>

                    <div className="overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
                      <div
                        onMouseDown={(event) => startDrag(event, sheet)}
                        onMouseMove={(event) => updateDrag(event, sheet)}
                        onMouseUp={stopDrag}
                        onMouseLeave={stopDrag}
                        className="relative cursor-crosshair"
                        style={{
                          width: `${sheet.width * zoom}px`,
                          height: `${sheet.height * zoom}px`,
                        }}
                      >
                        <NextImage
                          src={sheet.url}
                          alt={sheet.name}
                          fill
                          unoptimized
                          draggable={false}
                          className="pointer-events-none absolute inset-0 h-full w-full select-none"
                          style={{
                            transform: `translate(${xOffset * zoom}px, ${yOffset * zoom}px)`,
                          }}
                        />

                        <div
                          className="pointer-events-none absolute inset-0"
                          style={{
                            backgroundImage:
                              "linear-gradient(to right, rgba(15,23,42,0.18) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,0.18) 1px, transparent 1px)",
                            backgroundSize: `${tileSize * zoom}px ${tileSize * zoom}px`,
                          }}
                        />

                        {savedForSheet.map((slice) => (
                          <div
                            key={slice.id}
                            className="pointer-events-none absolute border-2 border-cyan-500 bg-cyan-400/20"
                            style={{
                              left: `${(slice.x + xOffset) * zoom}px`,
                              top: `${(slice.y + yOffset) * zoom}px`,
                              width: `${slice.width * zoom}px`,
                              height: `${slice.height * zoom}px`,
                            }}
                          />
                        ))}

                        {draftRect && (
                          <div
                            className="pointer-events-none absolute border-2 border-rose-500 bg-rose-400/20"
                            style={{
                              left: `${draftRect.x * zoom}px`,
                              top: `${draftRect.y * zoom}px`,
                              width: `${draftRect.width * zoom}px`,
                              height: `${draftRect.height * zoom}px`,
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-8 text-center text-sm font-semibold text-slate-600">
                Upload your sprite sheets to start selecting tile-aligned
                rectangles.
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}
