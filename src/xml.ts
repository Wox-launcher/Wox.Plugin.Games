const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

/** Decode manifest text without treating XML entities as literal paths or game names. */
export function decodeXmlText(value: string): string {
  return String(value || "")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
      if (entity[0] !== "#") return XML_ENTITIES[entity.toLowerCase()]
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
    .trim()
}

export function xmlAttribute(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag || "")
  return match ? decodeXmlText(match[2]) : ""
}

export function xmlTag(xml: string, tagName: string): string {
  return new RegExp(`<${tagName}\\b[^>]*>`, "i").exec(xml || "")?.[0] || ""
}
