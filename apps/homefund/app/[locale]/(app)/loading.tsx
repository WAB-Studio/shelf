// The dense skeleton passes `cell` renderers to `DataTable`, which is a client
// component: a server component cannot hand a function across that boundary and
// the whole shell 500s when it tries. Nothing here reads a request, so the file
// runs on the client and the functions stay inside one boundary.
"use client";

import {
  Box,
  CategoryTile,
  DataTable,
  Flex,
  Page,
  Skeleton,
  type DataColumn,
} from "@/components/ui";

// Enough rows to reach the fold on a phone without drawing a page of grey.
const ROWS = [0, 1, 2, 3, 4, 5];

// Eight, so the dense grid it is about to become reaches its own fold too.
const TABLE_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

// A generic dense row's tracks — tile, name, a secondary column and an amount —
// the shape most screens under the shell settle into, not any one of them.
const TABLE_WIDTHS = {
  tile: "44px",
  primary: "minmax(0, 1fr)",
  secondary: "160px",
  amount: "130px",
  menu: "36px",
} as const;

// Every cell is a shape, not a value, so no column needs a header to name it —
// the whole table stays out of the accessibility tree (below) while it loads.
const TABLE_COLUMNS: DataColumn<number>[] = [
  {
    key: "tile",
    header: "",
    width: TABLE_WIDTHS.tile,
    cell: () => <CategoryTile color={null} />,
  },
  {
    key: "primary",
    header: "",
    width: TABLE_WIDTHS.primary,
    cell: () => (
      <Flex direction="column" gap="2" minWidth="0">
        <Skeleton width="60%" height="var(--font-size-3)" />
        <Skeleton width="35%" height="var(--font-size-2)" />
      </Flex>
    ),
  },
  {
    key: "secondary",
    header: "",
    width: TABLE_WIDTHS.secondary,
    cell: () => <Skeleton width="70%" height="var(--font-size-2)" />,
  },
  {
    key: "amount",
    header: "",
    width: TABLE_WIDTHS.amount,
    align: "end",
    numeric: true,
    cell: () => <Skeleton width="4.5rem" height="var(--font-size-3)" />,
  },
  {
    key: "menu",
    header: "",
    width: TABLE_WIDTHS.menu,
    align: "end",
    cell: () => <Skeleton width="1.5rem" height="1.5rem" />,
  },
];

/**
 * The fallback for every screen under the signed-in shell. It draws the shape
 * they share — a title over a column of ledger rows — inside the same `Page`
 * gutter, so tapping a tab swaps only the body while the header and the tab bar
 * the layout renders stay put. From `md` up the ledger column is eight rows of
 * the dense table's grid instead, so the real `DataTable` that lands after it
 * does not visibly resize the page. `aria-hidden` keeps a table with nothing in
 * its cells out of the tree a screen reader walks — the ledger rows beside it
 * get none either.
 */
export default function Loading() {
  return (
    <Page gutter="flush-md">
      <Flex direction="column" gap="4">
        <Box px={{ md: "6" }}>
          <Skeleton width="9rem" height="var(--font-size-5)" />
        </Box>

        <Flex
          display={{ initial: "flex", md: "none" }}
          direction="column"
          gap="4"
        >
          {ROWS.map((row) => (
            <Flex key={row} align="center" gap="3">
              {/* The tile a category without a colour already wears: the same
                  neutral the skeleton pulses between, so it reads as one shape. */}
              <CategoryTile color={null} />
              <Flex direction="column" gap="2" flexGrow="1" minWidth="0">
                <Skeleton width="60%" height="var(--font-size-3)" />
                <Skeleton width="35%" height="var(--font-size-2)" />
              </Flex>
              <Skeleton width="4.5rem" height="var(--font-size-3)" />
            </Flex>
          ))}
        </Flex>

        <Box display={{ initial: "none", md: "block" }} aria-hidden="true">
          <DataTable
            label=""
            columns={TABLE_COLUMNS}
            rows={TABLE_ROWS}
            rowKey={(row) => String(row)}
          />
        </Box>
      </Flex>
    </Page>
  );
}
