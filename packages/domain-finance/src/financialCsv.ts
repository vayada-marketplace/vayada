/** Quote every CSV cell and neutralize spreadsheet formulas without changing numeric decimals. */
export const financeCsvRow = (values: readonly string[]) =>
  values
    .map((value) => {
      const safe =
        /^[=+\-@\t\r\n]/.test(value) && !/^-?(?:0|[1-9]\d*)(?:\.\d{4})?$/.test(value)
          ? `'${value}`
          : value;
      return `"${safe.replaceAll('"', '""')}"`;
    })
    .join(",");
