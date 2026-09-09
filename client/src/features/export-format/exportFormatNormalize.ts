import { DEFAULT_EXPORT_FORMAT } from '../../shared/types/exportFormat';
import type { ExportFormatConfig } from '../../shared/types/exportFormat';

// 模板 config 的全链路归一化：历史存档模板或手工改库记录可能缺少后加字段块，
// 预览/导出消费点直接访问 config.page.xxx 等会 render 期抛错。任何来源的
// 模板 config 在进入 UI/导出前先过这一层。
export function withExportFormatDefaults(source: ExportFormatConfig | null | undefined): ExportFormatConfig {
  const defaults = DEFAULT_EXPORT_FORMAT;
  const src: Partial<ExportFormatConfig> = (source && typeof source === 'object') ? source : {};
  return {
    ...defaults,
    ...src,
    page: { ...defaults.page, ...(src.page ?? {}) },
    heading_border: {
      ...defaults.heading_border,
      ...(src.heading_border ?? {}),
      level_cell_colors: defaults.heading_border.level_cell_colors.map((color, index) => src.heading_border?.level_cell_colors?.[index] || color),
    },
    headings: defaults.headings.map((heading, index) => ({ ...heading, ...((src.headings ?? [])[index] ?? {}) })),
    body_text: { ...defaults.body_text, ...(src.body_text ?? {}) },
    table: {
      ...defaults.table,
      ...(src.table ?? {}),
      header_row: { ...defaults.table.header_row, ...(src.table?.header_row ?? {}) },
      first_column: { ...defaults.table.first_column, ...(src.table?.first_column ?? {}) },
      body_cell: { ...defaults.table.body_cell, ...(src.table?.body_cell ?? {}) },
    },
    image: { ...defaults.image, ...(src.image ?? {}) },
  };
}
