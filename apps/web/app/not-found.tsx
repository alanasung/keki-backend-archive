export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-2xl font-semibold text-surface-900">Page not found</h1>
      <p className="text-sm text-surface-600">The page you are looking for does not exist.</p>
    </div>
  );
}
