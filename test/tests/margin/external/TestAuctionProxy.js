const BigNumber = require('bignumber.js');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-bignumber')());

const OwedToken = artifacts.require("TokenB");
const AuctionProxy = artifacts.require("AuctionProxy");
const DutchAuctionCloser = artifacts.require("DutchAuctionCloser");
const ZeroExProxy = artifacts.require("ZeroExProxy");
const ZeroExExchange = artifacts.require("ZeroExExchange");
const ZeroExExchangeWrapper = artifacts.require("ZeroExExchangeWrapper");
const ERC20Short = artifacts.require("ERC20Short");
const Margin = artifacts.require("Margin");

const { zeroExOrderToBytes } = require('../../../helpers/BytesHelper');
const { ADDRESSES, BIGNUMBERS, BYTES32 } = require('../../../helpers/Constants');
const { expectThrow } = require('../../../helpers/ExpectHelper');
const { transact } = require('../../../helpers/ContractHelper');
const { doOpenPosition } = require('../../../helpers/MarginHelper');
const { createSignedSellOrder, signOrder, getOrderHash } = require('../../../helpers/ZeroExHelper');
const { issueAndSetAllowance } = require('../../../helpers/TokenHelper');
const { wait } = require('@digix/tempo')(web3);

contract('AuctionProxy', accounts => {
  let owedToken;
  let dydxMargin;
  let dutchAuction;
  let zeroExExchange;
  let zeroExExchangeWrapper;
  let auctionProxy;

  let positionId;

  before('retrieve deployed contracts', async () => {
    [
      owedToken,
      dydxMargin,
      dutchAuction,
      zeroExExchangeWrapper,
      zeroExExchange,
    ] = await Promise.all([
      OwedToken.deployed(),
      Margin.deployed(),
      DutchAuctionCloser.deployed(),
      ZeroExExchangeWrapper.deployed(),
      ZeroExExchange.deployed(),
    ]);
    auctionProxy = await AuctionProxy.new(dydxMargin.address);
    const tx = await doOpenPosition(accounts);
    positionId = tx.id;

    // tokenify position
    const tokenContract = await ERC20Short.new(
      positionId,
      dydxMargin.address,
      accounts[2],
      [dutchAuction.address],
      [accounts[0]]
    );
    await dydxMargin.transferPosition(
      positionId,
      tokenContract.address,
      { from: tx.trader }
    );
    await dydxMargin.marginCall(positionId, 0, { from: tx.loanOffering.owner });
    await wait(tx.loanOffering.callTimeLimit * 99 / 100);
  });

  describe('Constructor', () => {
    it('sets constants correctly', async () => {
      const expectedAddress = ADDRESSES.TEST[0];
      const contract = await AuctionProxy.new(expectedAddress);
      const marginAddress = await contract.DYDX_MARGIN.call();
      expect(marginAddress).to.eq(expectedAddress);
    });

    it('fails for bad constants', async () => {
      await expectThrow(DutchAuctionCloser.new(Margin.address, 0, 2));
      await expectThrow(DutchAuctionCloser.new(Margin.address, 3, 2));
    });
  });

  describe('#closePosition', () => {
    it('succeeds', async () => {
      const order = await createOrder();

      // close it once normally using the dutchAuction
      await dydxMargin.closePosition(
        positionId,
        order.makerTokenAmount.div(2),
        dutchAuction.address,
        zeroExExchangeWrapper.address,
        true,
        zeroExOrderToBytes(order),
      );

      // close it using the auction proxy
      await transact(
        auctionProxy.closePosition,
        positionId,
        0,
        dutchAuction.address,
        zeroExExchangeWrapper.address,
        zeroExOrderToBytes(order)
      );

      const unavail = await zeroExExchange.getUnavailableTakerTokenAmount.call(getOrderHash(order));
      expect(order.takerTokenAmount.minus(unavail)).to.be.bignumber.lte(10);
    });

    it('returns zero for non-open position', async () => {
      const order = await createOrder();
      const receipt = await transact(
        auctionProxy.closePosition,
        BYTES32.BAD_ID,
        0,
        dutchAuction.address,
        zeroExExchangeWrapper.address,
        zeroExOrderToBytes(order)
      );
      expect(receipt.result).to.be.bignumber.equal(0);
    });

    it('fails early for taker fee', async () => {
      const order = await createOrder();
      order.feeRecipient = ADDRESSES.TEST[0];
      order.takerFee = new BigNumber(10);
      order.ecSignature = await signOrder(order);

      await expectThrow(
        auctionProxy.closePosition(
          positionId,
          0,
          dutchAuction.address,
          zeroExExchangeWrapper.address,
          zeroExOrderToBytes(order)
        )
      );
    });

    it('returns zero for large minCloseAmount', async () => {
      const order = await createOrder();
      const receipt = await transact(
        auctionProxy.closePosition,
        positionId,
        order.makerTokenAmount,
        dutchAuction.address,
        zeroExExchangeWrapper.address,
        zeroExOrderToBytes(order)
      );
      expect(receipt.result).to.be.bignumber.equal(0);
    });

    it('returns zero for expired order', async () => {
      const order = await createOrder();
      order.expirationUnixTimestampSec = new BigNumber(10);
      order.ecSignature = await signOrder(order);
      const receipt = await transact(
        auctionProxy.closePosition,
        positionId,
        0,
        dutchAuction.address,
        zeroExExchangeWrapper.address,
        zeroExOrderToBytes(order)
      );
      expect(receipt.result).to.be.bignumber.equal(0);
    });
  });

  async function createOrder() {
    let order = await createSignedSellOrder(accounts);
    order.makerFee = BIGNUMBERS.ZERO;
    order.takerFee = BIGNUMBERS.ZERO;
    order.makerTokenAmount = order.makerTokenAmount.div(100).floor();
    order.takerTokenAmount = order.takerTokenAmount.div(100).floor();
    order.feeRecipient = ADDRESSES.ZERO;
    order.ecSignature = await signOrder(order);
    await issueAndSetAllowance(
      owedToken,
      order.maker,
      order.makerTokenAmount,
      ZeroExProxy.address
    );
    return order;
  }
});
