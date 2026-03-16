# Pet-DB

A small, [Zod](https://zod.dev/) JSON-validated, local database library with type-safe migrations for pet projects.

Features:

- Cached Zod parse results which are invalidated on data mutations.
- Type-safe version migrations inferred automatically.

## Scripts

- `build`: Builds with [tsup](https://tsup.egoist.dev/).
- `typecheck`: Checks TypeScript types.
- `test` or `test --ui`: Runs [Vitest](https://vitest.dev/) tests.

## Getting Started

1. Install with: `npm install pet-db`
2. Create a pet-db instance with version migrations:

   ```ts
   import { createPetDb } from "pet-db";
   import { z } from "zod";

   const v1InputSchema = z.object({ value: z.string().max(10) });
   const v1OutputSchema = v1InputSchema.transform((d) => ({ ...d, valueWithExtra: `${d.value} +extra` }));

   const v2InputSchema = z.object({ value: z.string(), num: z.int() });
   const v2OutputSchema = v2InputSchema.transform((d) => ({ ...d, numString: d.num.toString() }));

   const petDb = createPetDb()
     .addVersion({
       version: 1,
       inputSchema: v1InputSchema,
       outputSchema: v1OutputSchema,
       migrate: () => ({ value: "default" }),
     })
     .addVersion({
       version: 2,
       inputSchema: v2InputSchema,
       outputSchema: v2OutputSchema,
       migrate: (old) => ({ value: old.value, num: 0 }),
     })
     .build("db.json");
   ```

3. Update and read data:

   ```ts
   await petDb.mutate((draft) => {
     draft.value = "new value";
     draft.num = 123;
   });

   console.log(await petDb.view()); // prints: { value: 'new value', num: 123, numString: '123' }
   ```
