package orchard;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal, reflection-free JSON support so the app compiles cleanly with GraalVM native-image.
 * Objects become {@link LinkedHashMap}, arrays {@link ArrayList}, integers {@link Long}, other numbers {@link Double}.
 */
public final class Json {
    private Json() {}

    public static Object parse(String text) {
        Parser p = new Parser(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != p.s.length()) throw p.err("Unexpected trailing characters");
        return v;
    }

    public static Map<String, Object> parseObject(String text) {
        Map<String, Object> m = map(parse(text));
        if (m == null) throw new IllegalArgumentException("Expected a JSON object");
        return m;
    }

    public static String write(Object o) {
        StringBuilder sb = new StringBuilder();
        write(sb, o);
        return sb.toString();
    }

    /** Builds an ordered, mutable map from alternating key/value arguments. */
    public static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> map(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : null;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> list(Object o) {
        return o instanceof List ? (List<Object>) o : List.of();
    }

    public static String str(Map<String, Object> m, String key) {
        if (m == null) return null;
        Object v = m.get(key);
        return v == null ? null : v.toString();
    }

    public static boolean bool(Map<String, Object> m, String key) {
        return m != null && Boolean.TRUE.equals(m.get(key));
    }

    // ------------------------------------------------------------------ writing

    private static void write(StringBuilder sb, Object o) {
        if (o == null) {
            sb.append("null");
        } else if (o instanceof String s) {
            quote(sb, s);
        } else if (o instanceof Boolean || o instanceof Integer || o instanceof Long
                || o instanceof Short || o instanceof Byte) {
            sb.append(o);
        } else if (o instanceof Number n) {
            double d = n.doubleValue();
            if (!Double.isFinite(d)) sb.append("null");
            else if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append((long) d);
            else sb.append(d);
        } else if (o instanceof Map<?, ?> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                quote(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (o instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object v : it) {
                if (!first) sb.append(',');
                first = false;
                write(sb, v);
            }
            sb.append(']');
        } else if (o instanceof Object[] arr) {
            write(sb, List.of(arr));
        } else {
            quote(sb, o.toString());
        }
    }

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                default -> {
                    // Escape '<' and the JS line separators so output is safe to embed in scripts.
                    if (c < 0x20 || c == '<' || c == ' ' || c == ' ') {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }

    // ------------------------------------------------------------------ parsing

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) {
            this.s = s;
        }

        IllegalArgumentException err(String msg) {
            return new IllegalArgumentException(msg + " at position " + i);
        }

        void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\n' || c == '\r' || c == '\t') i++;
                else break;
            }
        }

        Object value() {
            if (i >= s.length()) throw err("Unexpected end of input");
            char c = s.charAt(i);
            return switch (c) {
                case '{' -> object();
                case '[' -> array();
                case '"' -> string();
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> number();
            };
        }

        Object literal(String word, Object v) {
            if (!s.startsWith(word, i)) throw err("Invalid literal");
            i += word.length();
            return v;
        }

        Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++; // {
            ws();
            if (i < s.length() && s.charAt(i) == '}') {
                i++;
                return m;
            }
            while (true) {
                ws();
                if (i >= s.length() || s.charAt(i) != '"') throw err("Expected object key");
                String k = string();
                ws();
                if (i >= s.length() || s.charAt(i) != ':') throw err("Expected ':'");
                i++;
                ws();
                m.put(k, value());
                ws();
                if (i >= s.length()) throw err("Unterminated object");
                char c = s.charAt(i++);
                if (c == '}') return m;
                if (c != ',') throw err("Expected ',' or '}'");
            }
        }

        List<Object> array() {
            List<Object> l = new ArrayList<>();
            i++; // [
            ws();
            if (i < s.length() && s.charAt(i) == ']') {
                i++;
                return l;
            }
            while (true) {
                ws();
                l.add(value());
                ws();
                if (i >= s.length()) throw err("Unterminated array");
                char c = s.charAt(i++);
                if (c == ']') return l;
                if (c != ',') throw err("Expected ',' or ']'");
            }
        }

        String string() {
            i++; // opening quote
            StringBuilder sb = null;
            int start = i;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == '"') {
                    String out = sb == null ? s.substring(start, i) : sb.append(s, start, i).toString();
                    i++;
                    return out;
                }
                if (c == '\\') {
                    if (sb == null) sb = new StringBuilder();
                    sb.append(s, start, i);
                    i++;
                    if (i >= s.length()) break;
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"' -> sb.append('"');
                        case '\\' -> sb.append('\\');
                        case '/' -> sb.append('/');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'u' -> {
                            if (i + 4 > s.length()) throw err("Bad unicode escape");
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                        }
                        default -> throw err("Bad escape");
                    }
                    start = i;
                } else {
                    i++;
                }
            }
            throw err("Unterminated string");
        }

        Object number() {
            int start = i;
            boolean dbl = false;
            while (i < s.length()) {
                char c = s.charAt(i);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+') i++;
                else if (c == '.' || c == 'e' || c == 'E') {
                    dbl = true;
                    i++;
                } else break;
            }
            String n = s.substring(start, i);
            if (n.isEmpty()) throw err("Unexpected character '" + s.charAt(i) + "'");
            try {
                if (!dbl) return Long.parseLong(n);
            } catch (NumberFormatException ignored) {
                // falls through to double for very large integers
            }
            try {
                return Double.parseDouble(n);
            } catch (NumberFormatException e) {
                throw err("Bad number");
            }
        }
    }
}
