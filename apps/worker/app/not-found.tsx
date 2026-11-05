import Link from "next/link";

export default function NotFound() {
  return (
    <main className="content" style={{ paddingTop: 40 }}>
      <div className="callout warn" role="alert">
        <span className="title">That page doesn’t exist.</span>
        <p className="small">
          <Link href="/app" prefetch={false}>Go to the desk</Link> or <Link href="/">the home page</Link>.
        </p>
      </div>
    </main>
  );
}
