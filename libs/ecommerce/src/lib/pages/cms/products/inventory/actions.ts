'use server';

import { revalidatePath } from 'next/cache';

import { requireEcomAdmin } from '../../../../server-actions/require-ecom-role';
import {
  getInventoryItems,
  setSharedInventoryQuantity,
  type InventoryItem,
} from '../../../../shared-inventory';

interface UpdateInventoryQuantityInput {
  sku: string;
  stock: number;
}

function parseCsvRows(csvText: string) {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = '';
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    const nextCharacter = csvText[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        currentValue += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === ',' && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !inQuotes) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }

      if (currentValue.length > 0 || currentRow.length > 0) {
        currentRow.push(currentValue);
        rows.push(currentRow);
      }

      currentRow = [];
      currentValue = '';
      continue;
    }

    currentValue += character;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows.filter((row) => row.some((value) => value.trim().length > 0));
}

function buildInventoryKey(item: Pick<InventoryItem, 'sku'>) {
  return item.sku;
}

export async function updateInventoryQuantityAction(input: UpdateInventoryQuantityInput) {
  try {
    const supabase = await requireEcomAdmin();
    const stock = Math.max(0, Math.trunc(input.stock));

    await setSharedInventoryQuantity(
      {
        sku: input.sku,
        stock,
      },
      supabase
    );

    revalidatePath('/cms/products');
    revalidatePath('/cms/products/inventory');

    return {
      success: true,
      itemKey: buildInventoryKey(input),
      stock,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update inventory.',
    };
  }
}

export async function importInventoryCsvAction(csvText: string) {
  try {
    const supabase = await requireEcomAdmin();
    const parsedRows = parseCsvRows(csvText);

    if (parsedRows.length < 2) {
      return { success: false, error: 'The CSV file is empty.' };
    }

    const [headerRow, ...dataRows] = parsedRows;
    const headers = headerRow.map((header) => header.trim().toLowerCase());
    const skuIndex = headers.indexOf('sku');
    const stockIndex = headers.indexOf('stock');

    if (skuIndex === -1 || stockIndex === -1) {
      return {
        success: false,
        error:
          'The CSV format is invalid. Please import a file exported from the Inventory page.',
      };
    }

    let updatedCount = 0;

    for (const row of dataRows) {
      const sku = (row[skuIndex] || '').trim();
      const stockValue = Number.parseInt((row[stockIndex] || '').trim(), 10);

      if (!sku) {
        continue;
      }

      if (!Number.isFinite(stockValue) || stockValue < 0) {
        return {
          success: false,
          error: `Invalid stock value for SKU "${sku}".`,
        };
      }

      await setSharedInventoryQuantity(
        {
          sku,
          stock: stockValue,
        },
        supabase
      );

      updatedCount += 1;
    }

    const items = await getInventoryItems(supabase);

    revalidatePath('/cms/products');
    revalidatePath('/cms/products/inventory');

    return {
      success: true,
      updatedCount,
      items,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to import inventory CSV.',
    };
  }
}
