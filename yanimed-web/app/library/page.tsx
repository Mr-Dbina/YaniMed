import { connection } from "next/server";
import { AppShell } from "@/components/app-shell";
import { LibraryView } from "@/components/library/library-view";
import { getLibraryDir, listLibraryFiles } from "@/lib/library";

export const metadata = { title: "Library" };

// Reading the folder is request-time work that cannot be streamed or cached at
// build, so this route is allowed to block.
export const instant = false;

export default async function LibraryPage() {
  // The listing is read from disk at request time and changes without a
  // deploy, so this page opts out of the static prerender. `connection()` is
  // the Cache-Components-compatible way to do it - `export const dynamic`
  // is rejected while cacheComponents is on.
  await connection();

  let files: Awaited<ReturnType<typeof listLibraryFiles>> = [];
  let failed = false;

  try {
    files = await listLibraryFiles();
  } catch {
    // Missing or unreadable library folder - the view renders an empty state
    // rather than failing the route.
    failed = true;
  }

  return (
    <AppShell>
      <LibraryView files={failed ? [] : files} />
      {failed ? <LibraryMissingNotice /> : null}
    </AppShell>
  );
}

function LibraryMissingNotice() {
  return (
    <p className="library__notice">
      Library folder not found. Set <code>LIBRARY_DIR</code> to point at your files
      (currently <code>{getLibraryDir()}</code>).
    </p>
  );
}