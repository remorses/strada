// Compound CSS Grid component for declarative bento and mosaic layouts.

import { Children, cloneElement, isValidElement } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { cn } from "../lib/utils.ts";

type GridSize = number | string;

export interface GridProps {
  children: ReactNode;
  columns?: number;
  rows?: number;
  rowHeight?: GridSize;
  cellPadding?: GridSize;
  lines?: boolean;
  className?: string;
  style?: CSSProperties;
}

export interface GridItemProps {
  children: ReactNode;
  columnSpan?: number;
  rowSpan?: number;
  columnStart?: number | string;
  rowStart?: number | string;
  __gridPlacement?: GridPlacement;
  __gridCellPadding?: string;
  className?: string;
  style?: CSSProperties;
}

export interface GridLineExtensionsProps {
  side?: "top" | "bottom" | "both";
  length?: GridSize;
  padding?: GridSize;
  className?: string;
  style?: CSSProperties;
  __gridColumns?: number;
  __gridRows?: number;
  __gridDots?: GridDot[];
}

interface GridPlacement {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

interface GridDot {
  column: number;
  row: number;
}

function cssSize(value: GridSize) {
  return typeof value === "number" ? `${value}px` : value;
}

function GridRoot({
  children,
  columns = 12,
  rows,
  rowHeight = 120,
  cellPadding = 24,
  lines = false,
  className,
  style,
}: GridProps) {
  const childArray = Children.toArray(children);
  const extensionChildren = childArray.filter(isGridLineExtensionsElement);
  const cellPaddingValue = cssSize(cellPadding);
  const rowHeightValue = cssSize(rowHeight);
  const placements = rows ? placeGridItems({ children: childArray, columns, rows }) : [];
  const showLines = lines && rows != null;
  const lineSegments = rows && (showLines || extensionChildren.length > 0)
    ? getGridLineSegments({ columns, rows, placements })
    : undefined;
  const rowTrack = `minmax(${rowHeightValue}, auto)`;
  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gridTemplateRows: rows ? `repeat(${rows}, ${rowTrack})` : undefined,
    gridAutoRows: rowTrack,
    ...style,
  };

  return (
    <div
      className={cn("relative w-full", className)}
      style={gridStyle}
    >
      {showLines && lineSegments && <GridLines columns={columns} rows={rows} segments={lineSegments} />}
      {lineSegments && extensionChildren.map((child, index) => (
        cloneElement(child, {
          key: child.key ?? `line-extension-${index}`,
          __gridColumns: columns,
          __gridRows: rows,
          __gridDots: lineSegments.dots,
        })
      ))}
      {placements.length > 0 ? placements.map(({ child, ...placement }, index) => (
        cloneElement(child, { key: child.key ?? index, __gridPlacement: placement, __gridCellPadding: cellPaddingValue })
      )) : children}
    </div>
  );
}

function GridItem({
  children,
  columnSpan = 1,
  rowSpan = 1,
  columnStart,
  rowStart,
  __gridPlacement,
  __gridCellPadding,
  className,
  style,
}: GridItemProps) {
  const gridColumn = __gridPlacement
    ? `${__gridPlacement.column} / span ${__gridPlacement.columnSpan}`
    : `${columnStart ? `${columnStart} / ` : ""}span ${columnSpan}`;
  const gridRow = __gridPlacement
    ? `${__gridPlacement.row} / span ${__gridPlacement.rowSpan}`
    : `${rowStart ? `${rowStart} / ` : ""}span ${rowSpan}`;

  return (
    <div
      className={className}
      style={{
        gridColumn,
        gridRow,
        minWidth: 0,
        padding: __gridCellPadding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function GridLineExtensions({
  side = "both",
  length = 40,
  padding = 8,
  className,
  style,
  __gridColumns,
  __gridRows,
  __gridDots = [],
}: GridLineExtensionsProps) {
  if (!__gridColumns || !__gridRows) return null;

  const lengthValue = cssSize(length);
  const paddingValue = cssSize(padding);
  const sides = side === "both" ? ["top", "bottom"] : [side];

  return sides.flatMap((currentSide) => {
    const row = currentSide === "top" ? 0 : __gridRows;
    return __gridDots.filter((dot) => dot.row === row).map((dot) => (
      <div
        key={`${currentSide}-${dot.column}`}
        aria-hidden
        className={cn(
          "absolute z-20 w-px bg-border",
          className,
        )}
        style={{
          left: linePosition(dot.column, __gridColumns),
          top: currentSide === "top" ? `calc(-1 * (${lengthValue} + ${paddingValue}))` : `calc(100% + ${paddingValue})`,
          height: lengthValue,
          opacity: isEdgeLine(dot.column, __gridColumns) ? 0.55 : undefined,
          ...style,
        }}
      />
    ));
  });
}

export const Grid = Object.assign(GridRoot, { Item: GridItem, LineExtensions: GridLineExtensions });

function GridLines({ columns, rows, segments }: { columns: number; rows: number; segments: GridLineSegments }) {
  const { verticalSegments, horizontalSegments, dots } = segments;

  return (
    <>
      {verticalSegments.map(({ column, row }) => (
        <div
          key={`vertical-${column}-${row}`}
          aria-hidden
          className="pointer-events-none z-10 w-px self-stretch bg-border"
          style={{
            ...gridColumnLine(column, columns),
            gridRow: `${row + 1} / ${row + 2}`,
            opacity: isEdgeLine(column, columns) ? 0.55 : undefined,
          }}
        />
      ))}
      {horizontalSegments.map(({ column, row }) => (
        <div
          key={`horizontal-${column}-${row}`}
          aria-hidden
          className="pointer-events-none z-10 h-px justify-self-stretch bg-border"
          style={{
            gridColumn: `${column + 1} / ${column + 2}`,
            ...gridRowLine(row, rows),
          }}
        />
      ))}
      {dots.map(({ column, row }) => (
        <div
          key={`dot-${column}-${row}`}
          aria-hidden
          className={cn(
            "pointer-events-none z-20 flex size-5 items-center justify-center rounded-full bg-background after:block after:size-[2px] after:rounded-full after:bg-foreground after:content-['']",
            column === columns ? "translate-x-1/2" : "-translate-x-1/2",
            row === rows ? "translate-y-1/2" : "-translate-y-1/2",
          )}
          style={{
            ...gridColumnLine(column, columns),
            ...gridRowLine(row, rows),
          }}
        />
      ))}
    </>
  );
}

function gridColumnLine(column: number, columns: number): CSSProperties {
  if (column === columns) {
    return { gridColumn: `${columns} / ${columns + 1}`, justifySelf: "end" };
  }

  return { gridColumn: `${column + 1} / ${column + 2}`, justifySelf: "start" };
}

function gridRowLine(row: number, rows: number): CSSProperties {
  if (row === rows) {
    return { gridRow: `${rows} / ${rows + 1}`, alignSelf: "end" };
  }

  return { gridRow: `${row + 1} / ${row + 2}`, alignSelf: "start" };
}

function placeGridItems({ children, columns, rows }: { children: ReactNode; columns: number; rows: number }) {
  const occupied = Array.from({ length: rows }, () => Array.from({ length: columns }, () => false));
  const placements: Array<GridPlacement & { child: ReactElement<GridItemProps> }> = [];

  Children.forEach(children, (child) => {
    if (!isValidElement<GridItemProps>(child) || child.type !== GridItem) return;

    const columnSpan = child.props.columnSpan ?? 1;
    const rowSpan = child.props.rowSpan ?? 1;
    const explicitColumn = typeof child.props.columnStart === "number" ? child.props.columnStart : undefined;
    const explicitRow = typeof child.props.rowStart === "number" ? child.props.rowStart : undefined;
    const placement = explicitColumn && explicitRow
      ? { column: explicitColumn, row: explicitRow, columnSpan, rowSpan }
      : findOpenPlacement({ occupied, columns, rows, columnSpan, rowSpan });

    if (!placement) return;
    markOccupied(occupied, placement);
    placements.push({ child, ...placement });
  });

  return placements;
}

function isGridLineExtensionsElement(child: ReactNode): child is ReactElement<GridLineExtensionsProps> {
  return isValidElement<GridLineExtensionsProps>(child) && child.type === GridLineExtensions;
}

function findOpenPlacement({
  occupied,
  columns,
  rows,
  columnSpan,
  rowSpan,
}: {
  occupied: boolean[][];
  columns: number;
  rows: number;
  columnSpan: number;
  rowSpan: number;
}) {
  for (let row = 1; row <= rows - rowSpan + 1; row++) {
    for (let column = 1; column <= columns - columnSpan + 1; column++) {
      const placement = { column, row, columnSpan, rowSpan };
      if (canPlace(occupied, placement)) return placement;
    }
  }
}

function canPlace(occupied: boolean[][], placement: GridPlacement) {
  for (let row = placement.row - 1; row < placement.row - 1 + placement.rowSpan; row++) {
    for (let column = placement.column - 1; column < placement.column - 1 + placement.columnSpan; column++) {
      if (occupied[row]?.[column]) return false;
    }
  }
  return true;
}

function markOccupied(occupied: boolean[][], placement: GridPlacement) {
  for (let row = placement.row - 1; row < placement.row - 1 + placement.rowSpan; row++) {
    for (let column = placement.column - 1; column < placement.column - 1 + placement.columnSpan; column++) {
      occupied[row]![column] = true;
    }
  }
}

interface GridLineSegments {
  verticalSegments: Array<{ column: number; row: number }>;
  horizontalSegments: Array<{ column: number; row: number }>;
  dots: GridDot[];
}

function getGridLineSegments({ columns, rows, placements }: { columns: number; rows: number; placements: GridPlacement[] }): GridLineSegments {
  const owners = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ""));
  placements.forEach((placement, index) => {
    const owner = String(index + 1);
    for (let row = placement.row - 1; row < placement.row - 1 + placement.rowSpan; row++) {
      for (let column = placement.column - 1; column < placement.column - 1 + placement.columnSpan; column++) {
        owners[row]![column] = owner;
      }
    }
  });

  const verticalSegments: Array<{ column: number; row: number }> = [];
  const horizontalSegments: Array<{ column: number; row: number }> = [];
  const dotKeys = new Set<string>();

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const left = column === 0 ? "edge" : owners[row]![column - 1];
      const right = column === columns ? "edge" : owners[row]![column];
      if (left === right || (left === "" && right === "")) continue;
      verticalSegments.push({ column, row });
    }
  }

  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column < columns; column++) {
      const top = row === 0 ? "edge" : owners[row - 1]![column];
      const bottom = row === rows ? "edge" : owners[row]?.[column] ?? "";
      if (top === bottom || (top === "" && bottom === "")) continue;
      horizontalSegments.push({ column, row });
    }
  }

  const verticalDotCandidates = new Set<string>();
  const horizontalDotCandidates = new Set<string>();
  for (const segment of verticalSegments) {
    verticalDotCandidates.add(`${segment.column}:${segment.row}`);
    verticalDotCandidates.add(`${segment.column}:${segment.row + 1}`);
  }
  for (const segment of horizontalSegments) {
    horizontalDotCandidates.add(`${segment.column}:${segment.row}`);
    horizontalDotCandidates.add(`${segment.column + 1}:${segment.row}`);
  }
  for (const key of verticalDotCandidates) {
    if (horizontalDotCandidates.has(key)) dotKeys.add(key);
  }

  return {
    verticalSegments,
    horizontalSegments,
    dots: Array.from(dotKeys).map((key) => {
      const [column, row] = key.split(":").map(Number);
      return { column: column!, row: row! };
    }),
  };
}

function linePosition(index: number, tracks: number) {
  if (index === 0) return "0%";
  if (index === tracks) return "calc(100% - 1px)";
  return `${(index / tracks) * 100}%`;
}

function isEdgeLine(index: number, tracks: number) {
  return index === 0 || index === tracks;
}
