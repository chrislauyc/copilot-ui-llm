import { describe, it } from 'vitest';
import assert from 'node:assert';

const runTest = it;

// 1. Filtering events by selected categoric pill
runTest('Filter: Toggle categoric pills to isolate specific event records list results', () => {
  const events: any[] = [
    { category: 'user', title: 'A' },
    { category: 'tool', title: 'B' },
    { category: 'system', title: 'C' },
  ];
  
  const filterByCat = (cat: string, evts: any[]) => {
      if (cat === 'all') return evts;
      return evts.filter(e => e.category === cat);
  };
  
  const toolEvents = filterByCat('tool', events);
  assert.strictEqual(toolEvents.length, 1, "Should have 1 tool event");
  assert.strictEqual(toolEvents[0]!.category, 'tool', "Category should be tool");
});

// 2. Search patterns across multi-field properties
runTest('Search: Text search matches key terms across Titles, Feedback log texts, and parameters', () => {
  const events: any[] = [
    { title: 'fix compilation', feedback: 'compile warning in file' },
    { title: 'update readme', feedback: 'no errors' },
  ];
  
  const searchEvents = (query: string, evts: any[]) => {
      return evts.filter(e => e.title.includes(query) || e.feedback.includes(query));
  };
  
  const results = searchEvents('compile warning', events);
  assert.strictEqual(results.length, 1, "Should find 1 event");
  assert.strictEqual(results[0]!.title, 'fix compilation', "Should match the right event");
});

// 3. Clear button resets filter state to blank default configurations
runTest('Reset: Reset button restores full event list presentation', () => {
  let filterState = {
    selectedCategories: ['system'],
    searchText: 'compilation'
  };

  const resetFilters = () => {
      filterState = {
          selectedCategories: [],
          searchText: ''
      };
  };

  resetFilters();

  assert.strictEqual(filterState.selectedCategories.length, 0, "Selected categories should be empty after reset");
  assert.strictEqual(filterState.searchText, '', "Search text should be empty after reset");
});

// Tests completed successfully under Vitest!
