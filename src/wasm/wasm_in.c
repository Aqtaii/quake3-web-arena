#include "../client/client.h"

void IN_Init(void) {
    Com_Printf("------- Input Initialization (WebAssembly) -------\n");
}

void IN_Frame(void) {
}

void IN_Shutdown(void) {
}

void IN_Restart(void) {
    IN_Init();
}

void Sys_SendKeyEvents(void) {
}
