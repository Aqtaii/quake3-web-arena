#include "../server/server.h"

/* A closed reliable transport cannot receive the UDP zombie retransmits.
   Release its original game client immediately, including full-room refreshes. */
__attribute__((export_name("wasm_q3_drop_peer"), visibility("default")))
void Wasm_DropPeer(int peer) {
    int i;
    if (!svs.clients || !sv_maxclients) return;
    for (i = 0; i < sv_maxclients->integer; i++) {
        client_t *client = &svs.clients[i];
        netadr_t *address = &client->netchan.remoteAddress;
        if (client->state < CS_CONNECTED || address->type != NA_IP) continue;
        if (address->ip[0] != 10 || address->ip[1] != 0 || ((address->ip[2] << 8) | address->ip[3]) != peer) continue;
        SV_DropClient(client, "Connection closed");
        client->state = CS_FREE;
    }
}

/* Kept separate because the original client/server headers are unguarded. */
void Wasm_ServerStatus(float *data) {
    int i;
    data[11] = svs.time;
    if (!svs.clients || !sv_maxclients) return;
    for (i = 0; i < sv_maxclients->integer; i++) {
        client_t *client = &svs.clients[i];
        if (client->state < CS_ACTIVE || !client->gentity || !(client->gentity->r.svFlags & SVF_BOT)) continue;
        if (!data[7]) {
            int axis;
            for (axis = 0; axis < 3; axis++) data[8 + axis] = client->gentity->r.currentOrigin[axis];
            data[14] = client->lastUsercmd.weapon;
        }
        data[7]++;
    }
}
