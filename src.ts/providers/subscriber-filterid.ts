import { PollingEventSubscriber } from "./subscriber-polling.js";

import type { AbstractProvider, Subscriber } from "./abstract-provider.js";
import type { Network } from "./network.js";
import type { EventFilter } from "./provider.js";
import type { JsonRpcApiProvider } from "./provider-jsonrpc.js";


function copy(obj: any): any {
    return JSON.parse(JSON.stringify(obj));
}

/**
 *  Some backends support subscribing to events using a Filter ID.
 *
 *  When subscribing with this technique, the node issues a unique
 *  //Filter ID//. At this point the node dedicates resources to
 *  the filter, so that periodic calls to follow up on the //Filter ID//
 *  will receive any events since the last call.
 *
 *  @_docloc: api/providers/abstract-provider
 */
export class FilterIdSubscriber implements Subscriber {
    #provider: JsonRpcApiProvider;

    #filterIdPromise: null | Promise<string>;
    #poller: (b: number) => Promise<void>;

    #network: null | Network;

    #hault: boolean;

    constructor(provider: JsonRpcApiProvider) {
        this.#provider = provider;

        this.#filterIdPromise = null;
        this.#poller = this.#poll.bind(this);

        this.#network = null;

        this.#hault = false;
    }

    _subscribe(provider: JsonRpcApiProvider): Promise<string> {
        throw new Error("subclasses must override this");
    }

    _emitResults(provider: AbstractProvider, result: Array<any>): Promise<void> {
        throw new Error("subclasses must override this");
    }

    _recover(provider: AbstractProvider): Subscriber {
        throw new Error("subclasses must override this");
    }

    async #poll(blockNumber: number): Promise<void> {
        try {
            if (this.#filterIdPromise == null) {
                this.#filterIdPromise = this._subscribe(this.#provider);
            }

            const filterId = await this.#filterIdPromise;
            if (filterId == null) {
                this.#provider._recoverSubscriber(this, this._recover(this.#provider));
                return;
            }

            const network = await this.#provider.getNetwork();
            if (!this.#network) { this.#network = network; }

            if ((this.#network as Network).chainId !== network.chainId) {
                throw new Error("chaid changed");
            }

            if (this.#hault) { return; }

            const result = await this.#provider.send("eth_getFilterChanges", [ filterId ]);
            await this._emitResults(this.#provider, result);
        } catch (error) { console.log("@TODO", error); }

        this.#provider.once("block", this.#poller);
    }

    #teardown(): void {
        const filterIdPromise = this.#filterIdPromise;
        if (filterIdPromise) {
            this.#filterIdPromise = null;
            filterIdPromise.then((filterId) => {
                this.#provider.send("eth_uninstallFilter", [ filterId ]);
            });
        }
    }

    start(): void { this.#poll(-2); }

    stop(): void {
        this.#hault = true;
        this.#teardown();
        this.#provider.off("block", this.#poller);
    }

    pause(dropWhilePaused?: boolean): void {
        if (dropWhilePaused){ this.#teardown(); }
        this.#provider.off("block", this.#poller);
    }

    resume(): void { this.start(); }
}

/**
 *  A **FilterIdSubscriber** for receiving contract events.
 *
 *  @_docloc: api/providers/abstract-provider
 */
export class FilterIdEventSubscriber extends FilterIdSubscriber {
    #event: EventFilter;

    constructor(provider: JsonRpcApiProvider, filter: EventFilter) {
        super(provider);
        this.#event = copy(filter);
    }

    _recover(provider: AbstractProvider): Subscriber {
        return new PollingEventSubscriber(provider, this.#event);
    }

    async _subscribe(provider: JsonRpcApiProvider): Promise<string> {
        const filterId = await provider.send("eth_newFilter", [ this.#event ]);
        return filterId;
    }

    async _emitResults(provider: JsonRpcApiProvider, results: Array<any>): Promise<void> {
        for (const result of results) {
            provider.emit(this.#event, provider._wrapLog(result, provider._network));
        }
    }
}

/**
 *  A **FilterIdSubscriber** for receiving pending transactions events.
 *
 *  @_docloc: api/providers/abstract-provider
 */
export class FilterIdPendingSubscriber extends FilterIdSubscriber {
    async _subscribe(provider: JsonRpcApiProvider): Promise<string> {
        return await provider.send("eth_newPendingTransactionFilter", [ ]);
    }

    async _emitResults(provider: JsonRpcApiProvider, results: Array<any>): Promise<void> {
        for (const result of results) {
            provider.emit("pending", result);
        }
    }
}
