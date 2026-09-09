// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

contract Groth16Verifier {
    uint256 private constant SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 private constant BASE_FIELD =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 private constant PUBLIC_INPUTS = 8;

    address private constant EC_ADD = address(0x06);
    address private constant EC_MUL = address(0x07);
    address private constant PAIRING = address(0x08);

    uint256 private constant ALPHA_X = 16428432848801857252194528405604668803277877773566238944394625302971855135431;
    uint256 private constant ALPHA_Y = 16846502678714586896801519656441059708016666274385668027902869494772365009666;

    uint256 private constant BETA_X_IM = 3182164110458002340215786955198810119980427837186618912744689678939861918171;
    uint256 private constant BETA_X_RE = 16348171800823588416173124589066524623406261996681292662100840445103873053252;
    uint256 private constant BETA_Y_IM = 4920802715848186258981584729175884379674325733638798907835771393452862684714;
    uint256 private constant BETA_Y_RE = 19687132236965066906216944365591810874384658708175106803089633851114028275753;

    uint256 private constant GAMMA_X_IM = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 private constant GAMMA_X_RE = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 private constant GAMMA_Y_IM = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 private constant GAMMA_Y_RE = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    uint256 private constant DELTA_X_IM = 19084934287660233487077259895674153957886250479841793864821218276094519638827;
    uint256 private constant DELTA_X_RE = 6006476619374963195086066312055931639676084251008502435430257589894973280791;
    uint256 private constant DELTA_Y_IM = 17503153790344637601872005536969014687711342012253788532289508596629205777038;
    uint256 private constant DELTA_Y_RE = 5634425035067089001704675787237762994126743438510543188682903594218733745219;

    uint256 private constant IC0_X = 16704497311840442387411113853150704967814134749429149735668580175921494571058;
    uint256 private constant IC0_Y = 9874885146633804909462837108398984958803149384183069034340464011196491941755;
    uint256 private constant IC1_X = 13141605992393202052204864925419037431281838607079637116771688043492042239198;
    uint256 private constant IC1_Y = 3418612494112701794395106401479346938037549713476401086103196282838667963906;
    uint256 private constant IC2_X = 6816550324559628656434570649925047771027644170434312720227510239932302463191;
    uint256 private constant IC2_Y = 20064987539579126517804327216579073339012660480985117464811437705142289583910;
    uint256 private constant IC3_X = 13125926247786034929334247377678454437578523543221516284536800345660518881876;
    uint256 private constant IC3_Y = 8327697279100215917098625076466681734744687470152635492989037296591793660332;
    uint256 private constant IC4_X = 17819813535748332302748555035212883471533648904747365028911500128204094182810;
    uint256 private constant IC4_Y = 16219119065264442252038708248691427556856370813941392797225216720418207980994;
    uint256 private constant IC5_X = 3848022003144814332350354302813843764787538077812966084666549233829896985886;
    uint256 private constant IC5_Y = 15806530990974318803149266426305599386620234655182538253455809966104886949501;
    uint256 private constant IC6_X = 6674805058595484818305409267831124372952294594869533956478684041435547804545;
    uint256 private constant IC6_Y = 10435370002578684171449791117995814347046623162587714977804203737008760131155;
    uint256 private constant IC7_X = 21867741483475056567436672026544892446151703851008954411669797275945435051577;
    uint256 private constant IC7_Y = 2607264421562083286014660301980060990471984658925757688415793447723719962818;
    uint256 private constant IC8_X = 17526398051890908714695072238312538681770168777986592012542338076146733253435;
    uint256 private constant IC8_Y = 10553691344508497826438500863748154773123498618682113867470273920207575004718;

    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata input
    ) public view returns (bool) {
        for (uint256 i = 0; i < PUBLIC_INPUTS; i++) {
            if (input[i] >= SCALAR_FIELD) return false;
        }
        (bool combined, uint256 lx, uint256 ly) = _publicInputCommitment(input);
        if (!combined) return false;
        return _pairingProductIsOne(a, b, c, lx, ly);
    }

    function _publicInputCommitment(uint256[8] calldata input) private view returns (bool, uint256, uint256) {
        uint256[2][8] memory ic = [
            [IC1_X, IC1_Y],
            [IC2_X, IC2_Y],
            [IC3_X, IC3_Y],
            [IC4_X, IC4_Y],
            [IC5_X, IC5_Y],
            [IC6_X, IC6_Y],
            [IC7_X, IC7_Y],
            [IC8_X, IC8_Y]
        ];
        uint256 x = IC0_X;
        uint256 y = IC0_Y;
        for (uint256 i = 0; i < PUBLIC_INPUTS; i++) {
            (bool scaled, uint256 px, uint256 py) = _scalarMultiply(ic[i][0], ic[i][1], input[i]);
            if (!scaled) return (false, 0, 0);
            (bool added, uint256 sx, uint256 sy) = _add(x, y, px, py);
            if (!added) return (false, 0, 0);
            x = sx;
            y = sy;
        }
        return (true, x, y);
    }

    function _scalarMultiply(uint256 x, uint256 y, uint256 scalar) private view returns (bool, uint256, uint256) {
        (bool ok, bytes memory out) = EC_MUL.staticcall(abi.encode(x, y, scalar));
        if (!ok || out.length != 64) return (false, 0, 0);
        (uint256 rx, uint256 ry) = abi.decode(out, (uint256, uint256));
        return (true, rx, ry);
    }

    function _add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) private view returns (bool, uint256, uint256) {
        (bool ok, bytes memory out) = EC_ADD.staticcall(abi.encode(x1, y1, x2, y2));
        if (!ok || out.length != 64) return (false, 0, 0);
        (uint256 rx, uint256 ry) = abi.decode(out, (uint256, uint256));
        return (true, rx, ry);
    }

    function _pairingProductIsOne(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256 lx,
        uint256 ly
    ) private view returns (bool) {
        if (a[1] >= BASE_FIELD) return false;
        uint256 negatedAy = a[1] == 0 ? 0 : BASE_FIELD - a[1];
        uint256[24] memory pairs;
        pairs[0] = a[0];
        pairs[1] = negatedAy;
        pairs[2] = b[0][0];
        pairs[3] = b[0][1];
        pairs[4] = b[1][0];
        pairs[5] = b[1][1];
        pairs[6] = ALPHA_X;
        pairs[7] = ALPHA_Y;
        pairs[8] = BETA_X_IM;
        pairs[9] = BETA_X_RE;
        pairs[10] = BETA_Y_IM;
        pairs[11] = BETA_Y_RE;
        pairs[12] = lx;
        pairs[13] = ly;
        pairs[14] = GAMMA_X_IM;
        pairs[15] = GAMMA_X_RE;
        pairs[16] = GAMMA_Y_IM;
        pairs[17] = GAMMA_Y_RE;
        pairs[18] = c[0];
        pairs[19] = c[1];
        pairs[20] = DELTA_X_IM;
        pairs[21] = DELTA_X_RE;
        pairs[22] = DELTA_Y_IM;
        pairs[23] = DELTA_Y_RE;
        (bool ok, bytes memory out) = PAIRING.staticcall(abi.encode(pairs));
        if (!ok || out.length != 32) return false;
        return abi.decode(out, (uint256)) == 1;
    }
}
