import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ContractAddress = { bytes: Uint8Array };

export type Either<A, B> = { is_left: boolean; left: A; right: B };

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  balanceOf(context: __compactRuntime.CircuitContext<PS>,
            account_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  allowance(context: __compactRuntime.CircuitContext<PS>,
            owner_0: Either<Uint8Array, ContractAddress>,
            spender_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type ProvableCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  balanceOf(context: __compactRuntime.CircuitContext<PS>,
            account_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  allowance(context: __compactRuntime.CircuitContext<PS>,
            owner_0: Either<Uint8Array, ContractAddress>,
            spender_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  balanceOf(context: __compactRuntime.CircuitContext<PS>,
            account_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  allowance(context: __compactRuntime.CircuitContext<PS>,
            owner_0: Either<Uint8Array, ContractAddress>,
            spender_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type Ledger = {
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
