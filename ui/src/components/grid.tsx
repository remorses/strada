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

interface GridPlacement {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
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
  const cellPaddingValue = cssSize(cellPadding);
  const rowHeightValue = cssSize(rowHeight);
  const placements = rows ? placeGridItems({ children, columns, rows }) : [];
  const showLines = lines && rows != null;
  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gridTemplateRows: rows ? `repeat(${rows}, ${rowHeightValue})` : undefined,
    gridAutoRows: rowHeightValue,
    ...style,
  };

  return (
    <div
      className={cn("relative w-full", className)}
      style={gridStyle}
    >
      {showLines && <GridLines columns={columns} rows={rows} placements={placements} />}
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

export const Grid = Object.assign(GridRoot, { Item: GridItem });

function GridLines({ columns, rows, placements }: { columns: number; rows: number; placements: GridPlacement[] }) {
  const { verticalSegments, horizontalSegments, dots } = getGridLineSegments({ columns, rows, placements });

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      {verticalSegments.map(({ column, row }) => (
        <div
          key={`vertical-${column}-${row}`}
          className="absolute w-px bg-border"
          style={{
            left: linePosition(column, columns),
            top: linePosition(row, rows),
            bottom: `calc(100% - ${linePosition(row + 1, rows)})`,
          }}
        />
      ))}
      {horizontalSegments.map(({ column, row }) => (
        <div
          key={`horizontal-${column}-${row}`}
          className="absolute h-px bg-border"
          style={{
            left: linePosition(column, columns),
            right: `calc(100% - ${linePosition(column + 1, columns)})`,
            top: linePosition(row, rows),
          }}
        />
      ))}
      {dots.map(({ column, row }) => (
        <div
          key={`dot-${column}-${row}`}
          className="absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background after:block after:size-[2px] after:rounded-full after:bg-foreground after:content-['']"
          style={{ left: linePosition(column, columns), top: linePosition(row, rows) }}
        />
      ))}
    </div>
  );
}

function placeGridItems({ children, columns, rows }: { children: ReactNode; columns: number; rows: number }) {
  const occupied = Array.from({ length: rows }, () => Array.from({ length: columns }, () => false));
  const placements: Array<GridPlacement & { child: ReactElement<GridItemProps> }> = [];

  Children.forEach(children, (child) => {
    if (!isValidElement<GridItemProps>(child)) return;

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

function getGridLineSegments({ columns, rows, placements }: { columns: number; rows: number; placements: GridPlacement[] }) {
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
  if (index === tracks) return "100%";
  return `${(index / tracks) * 100}%`;
}
