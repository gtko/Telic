import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rangeIds, resolveColumns, SELECT_COLUMN_WIDTH, selectedState } from './table';

describe('table row range selection', () => {
  const visible = [10, 11, 12, 13, 14];

  it('takes the rows from the anchor to the clicked row, in either direction', () => {
    assert.deepEqual(rangeIds(visible, 11, 13), [11, 12, 13]);
    assert.deepEqual(rangeIds(visible, 13, 11), [11, 12, 13]);
  });

  it('takes only the clicked row without a visible anchor', () => {
    assert.deepEqual(rangeIds(visible, null, 12), [12]);
    assert.deepEqual(rangeIds(visible, 99, 12), [12]);
  });
});

describe('select-all state', () => {
  it('is checked when every id is selected, indeterminate on some, unchecked on none', () => {
    const ids = [1, 2, 3];
    assert.equal(selectedState(ids, new Set([1, 2, 3, 4])), true);
    assert.equal(selectedState(ids, new Set([2])), 'indeterminate');
    assert.equal(selectedState(ids, new Set([9])), false);
  });
});

describe('table grid layout', () => {
  const tracks = (selectable: boolean) =>
    resolveColumns([], [], {}, selectable).gridTemplate.split(' ');

  it('leads with the select column only when the table is editable', () => {
    assert.equal(tracks(true)[0], SELECT_COLUMN_WIDTH);
    assert.equal(tracks(true).length, tracks(false).length + 1);
    assert.notEqual(tracks(false)[0], SELECT_COLUMN_WIDTH);
  });
});
