import { request } from '@/lib/api/core/client';

export type CustomFieldType =
  | 'text'
  | 'markdown'
  | 'url'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'datetime_range'
  | 'select'
  | 'multi_select'
  | 'member';

export interface CustomFieldOption {
  id: number;
  value: string;
  color: string;
  position: number;
}

export interface CustomField {
  id: number;
  issueTypeId: number | null;
  name: string;
  fieldType: CustomFieldType;
  // When true the field renders in the issue body (under the description);
  // when false it renders as a Properties row.
  showInBody: boolean;
  position: number;
  options: CustomFieldOption[];
}

// A field can be reshaped after it exists, and the values issues hold follow: a new
// fieldType clears them, and an option missing from `options` is deleted along with the selections of it.
export interface CustomFieldPatch {
  name?: string;
  showInBody?: boolean;
  fieldType?: CustomFieldType;
  // The full option list of a select field, in display order. An entry with an id
  // renames that option; one without is new.
  options?: { id?: number; value: string }[];
}

export interface NewCustomFieldInput {
  issueTypeId?: number | null;
  name: string;
  fieldType: CustomFieldType;
  showInBody?: boolean;
  options?: string[];
}

export const createCustomField = (projectKey: string, input: NewCustomFieldInput) =>
  request<CustomField>(`/projects/${projectKey}/custom-fields`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const updateCustomField = (projectKey: string, fieldId: number, patch: CustomFieldPatch) =>
  request<CustomField>(`/projects/${projectKey}/custom-fields/${fieldId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const deleteCustomField = (projectKey: string, fieldId: number) =>
  request<void>(`/projects/${projectKey}/custom-fields/${fieldId}`, { method: 'DELETE' });
