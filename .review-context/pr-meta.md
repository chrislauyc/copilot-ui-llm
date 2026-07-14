# PR Metadata

## Title
feat: implement stable specification identification and PBI/Task migration

## Description
This pull request addresses key review feedback and structural improvements for the copilot-ui-llm task manager layer:

1. **Stable Specification Identification & Migration**: Implemented a robust mechanism in `decomposeSpecIntoTasks` to track and reuse `specId`s when specification files are renamed or moved within the workspace. This prevents orphaned Product Backlog Items (PBIs) and tasks, ensuring historical state and completion progress are perfectly preserved.
2. **Migration Redundancy Cleanup**: Removed the unsafe `try-catch` wrapper around the `ALTER TABLE` execution inside `src/db/index.ts` and replaced it with a clean schema-existence check utilizing SQLite's `table_info` pragma.
3. **PBI Update Stability**: Preserved the catch-all PBI's `updatedAt` field across subsequent decompositions when no underlying fields are changed.
4. **Comprehensive Test Coverage**: Added rigorous integration tests validating the move/rename migration path and verified that the entire 167-test suite passes with 100% success.
