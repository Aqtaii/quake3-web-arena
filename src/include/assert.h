#ifndef _WASM_ASSERT_H
#define _WASM_ASSERT_H

#undef assert
#ifdef NDEBUG
#define assert(x) ((void)0)
#else
void __wasm_assert_fail(const char *expr, const char *file, int line);
#define assert(x) ((void)((x) || (__wasm_assert_fail(#x, __FILE__, __LINE__), 0)))
#endif

#endif
