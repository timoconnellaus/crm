// Text modules (wrangler's default `**/*.txt` rule): imported as their contents.
declare module "*.txt" {
  const text: string;
  export default text;
}
