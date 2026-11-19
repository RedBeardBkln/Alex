import { Parser } from "htmlparser2";

/**
 * Tester oracle: the maximum open-element stack length htmlparser2 actually reaches on `html`, driven
 * exactly as sanitize-html 2.18.2 drives it (CDATA rewrite, then `new Parser(cbs, { decodeEntities:
 * true })`). The stack is read from the parser itself after every callback.
 */
export function oracleDepth(html: string): number {
  const input = html.replaceAll("<![CDATA[", "<!&#91;CDATA[");
  let max = 0;
  // eslint-disable-next-line prefer-const
  let parser: Parser;
  const look = () => {
    const len = (parser as unknown as { stack: string[] }).stack.length;
    if (len > max) max = len;
  };
  parser = new Parser(
    { onopentagname: look, onopentag: look, onattribute: look, onclosetag: look, ontext: look, oncomment: look, onprocessinginstruction: look },
    { decodeEntities: true },
  );
  parser.write(input);
  look();
  parser.end();
  return max;
}
