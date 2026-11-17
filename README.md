# Entity Review

Static deployment of the physician annotation interface with 1004 NER_V2 documents: 240 ACI Bench, 200 MEDMENTIONS abstracts, 200 representative CADEC forum documents, 168 MedDialog dialogues, 164 MIMIC-IV notes, and 32 PriMock57 documents (16 dialogues, 16 notes). `index.html` is the entry point.

## Multi-annotator review storage

Every annotator must enter an assigned ID such as `annotator-01`. Review state is keyed by both annotator ID and document ID, so different annotators can review the same source document independently.

Edits are written to browser storage first and synchronized to Cloudflare D1 through the Worker API. If the API is unavailable, annotation can continue locally and the header displays **Saved locally**. Loading the same dataset later restores the newest available local or cloud copy. The source JSON files under `data/` are never modified.

The Export menu remains available for downloading reviewed JSON as a portable backup. Exports include the annotator ID in `review_metadata`.

> Annotator IDs separate work but are not passwords. Assign a unique ID to each person. For access control, protect the Worker with Cloudflare Access before sharing it outside the annotation team.

## Assigning work to annotators

`src/assignments.json` lists every valid annotator ID and the documents it reviews. After entering their ID, an annotator sees only their assigned documents (loaded automatically, with their saved reviews restored); the dataset menu and file upload are hidden. Unknown IDs are rejected, and IDs are matched case-insensitively.

```json
{
  "annotators": {
    "annotator-01": ["dialogues/aci_bench/test1", "notes/aci_bench/test1"],
    "annotator-02": ["dialogues/meddialog_en[0:84]"],
    "annotator-03": ["dialogues/meddialog_en[84:]"],
    "lead": ["*"]
  }
}
```

Each entry is one of: `"*"` (everything), a folder key from `aci-bench-manifest.json` or a prefix of one (`"dialogues"` = all dialogues), a slice of it (`"folder[start:end]"`, in manifest order), or a single file path such as `"data/NER/notes/primock57/day1_consultation06.json"`. The file lives in `src/`, which is not served publicly, so the list of IDs is not exposed. Redeploy after editing it. With an empty `annotators` object, the app falls back to open mode (any ID, all datasets).

Reviews are stored under the exact configured ID, so keep the spelling of IDs that already have saved work.

## Cloudflare setup

The repository contains a Worker in `src/worker.js`, a D1 migration in `migrations/`, and static-asset configuration in `wrangler.jsonc`. Node.js 20 or newer is required by Wrangler.

1. Install Wrangler:

   ```bash
   npm install
   ```

2. Authenticate with the Cloudflare account that owns the Worker:

   ```bash
   npx wrangler login
   ```

3. Deploy to the existing Worker:

   ```bash
   npm run deploy
   ```

The configured Worker name is `annotation-verification-ui`, matching the current `annotation-verification-ui.youssef-khalil.workers.dev` deployment. Wrangler 4.45 or newer automatically provisions and links the `REVIEW_DB` D1 binding on the first deployment. The Worker creates its idempotent schema on the first API request, while the migration file remains available for controlled database setup. Future deployments reuse the linked database even though no account-specific database ID is committed to Git.

For local development:

```bash
npm run db:migrate:local
npm run dev
```

Wrangler keeps the local D1 database under `.wrangler/`; it is ignored by Git.

## API and data model

- `POST /api/annotators/register` registers or refreshes an annotator ID.
- `POST /api/reviews/batch` restores reviews for a list of documents.
- `PUT /api/reviews/:documentId` upserts one annotator's review.
- `POST /api/reviews/clear` clears selected reviews for the active annotator.
- `GET /api/health` confirms that the D1 binding is available.

The D1 primary key is `(annotator_id, doc_id)`. Saved rows include the current entity state, completion status, update time, and revision number.
