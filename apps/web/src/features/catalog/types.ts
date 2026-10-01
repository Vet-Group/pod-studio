export interface OptionView {
  name: string;
  values: string[];
}
export interface PriceRowView {
  id: string;
  optionValues: Record<string, string>;
  price: string;
  excludedMarkets: string[];
}
export interface ProductTypeView {
  id: string;
  name: string;
  currency: string;
  options: OptionView[];
  revision: number;
  rows: PriceRowView[];
}
