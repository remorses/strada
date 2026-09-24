'use client'

// TanStack Table v9 wrapper, ported from celato/harefs data-table.tsx.
// Styling follows the Linear issues list: dense rows, no zebra, muted
// sortable headers, and optional collapsible group sections.

import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { cn } from '../lib/utils.ts'

type ColumnMeta = {
  // Applied to both th and td, use for width and alignment.
  className?: string
}

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
  columnMeta: {} as ColumnMeta,
})

export function createAppColumnHelper<TData extends RowData>() {
  return createColumnHelper<typeof features, TData>()
}

export type TableGroup = {
  id: string
  label: string
  icon?: ReactNode
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  groups,
  getGroupId,
  activeRowId,
  onRowClick,
  hideHeader,
  dense,
  className,
}: {
  columns: Array<ColumnDef<typeof features, TData, any>>
  data: TData[]
  getRowId: (row: TData) => string
  groups?: TableGroup[]
  getGroupId?: (row: TData) => string
  activeRowId?: string
  onRowClick?: (row: TData) => void
  hideHeader?: boolean
  dense?: boolean
  className?: string
}) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const table = useTable({
    features,
    columns,
    data,
    getRowId,
    state: { sorting },
    onSortingChange: setSorting,
  })

  const rows = table.getRowModel().rows
  const sections = groups && getGroupId
    ? groups
        .map((group) => ({ group, rows: rows.filter((row) => getGroupId(row.original) === group.id) }))
        .filter((section) => section.rows.length > 0)
    : [{ group: undefined, rows }]
  const columnCount = table.getAllLeafColumns().length

  return (
    <div className={cn('relative w-full overflow-x-auto', className)}>
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        {hideHeader ? null : (
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort()
                  const sorted = header.column.getIsSorted()
                  return (
                    <th
                      key={header.id}
                      className={cn(
                        'h-8 border-b border-border px-2 text-left align-middle text-xs font-normal whitespace-nowrap text-muted-foreground first:pl-3 last:pr-3',
                        canSort && 'cursor-pointer select-none hover:text-foreground',
                        header.column.columnDef.meta?.className,
                      )}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {header.isPlaceholder ? null : (
                        <span className="inline-flex items-center gap-1">
                          <table.FlexRender header={header} />
                          {sorted === 'asc' ? <ArrowUpIcon className="size-3" /> : null}
                          {sorted === 'desc' ? <ArrowDownIcon className="size-3" /> : null}
                        </span>
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
        )}
        <tbody>
          {sections.map(({ group, rows: sectionRows }) => {
            const isCollapsed = group ? collapsed.has(group.id) : false
            return (
              <Fragment key={group?.id ?? 'all'}>
                {group ? (
                  <tr>
                    <td colSpan={columnCount} className="p-0">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsed((previous) => {
                            const next = new Set(previous)
                            if (next.has(group.id)) next.delete(group.id)
                            else next.add(group.id)
                            return next
                          })
                        }
                        className="mt-1 flex h-9 w-full items-center gap-2 rounded-lg bg-muted px-3 text-left text-[13px] font-medium hover:bg-accent"
                      >
                        <ChevronRightIcon
                          className={cn('size-3 text-muted-foreground transition-transform', !isCollapsed && 'rotate-90')}
                        />
                        {group.icon}
                        {group.label}
                        <span className="font-normal text-muted-foreground tabular-nums">{sectionRows.length}</span>
                      </button>
                    </td>
                  </tr>
                ) : null}
                {isCollapsed
                  ? null
                  : sectionRows.map((row) => (
                      <tr
                        key={row.id}
                        data-active={row.id === activeRowId ? '' : undefined}
                        onClick={() => onRowClick?.(row.original)}
                        className={cn(
                          'group/row hover:bg-muted/70 data-active:bg-muted',
                          onRowClick && 'cursor-pointer',
                        )}
                      >
                        {row.getAllCells().map((cell) => (
                          <td
                            key={cell.id}
                            className={cn(
                              'border-b border-border/60 px-2 align-middle whitespace-nowrap first:rounded-l-lg first:pl-3 last:rounded-r-lg last:pr-3',
                              dense ? 'h-8' : 'h-10',
                              cell.column.columnDef.meta?.className,
                            )}
                          >
                            <table.FlexRender cell={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
