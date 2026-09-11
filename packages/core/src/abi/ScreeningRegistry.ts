export const screeningRegistryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "initialOwner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "maxAge_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "MAX_MAX_AGE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_MAX_AGE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SCREENING_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "digestOf",
    "inputs": [
      {
        "name": "screening",
        "type": "tuple",
        "internalType": "struct IScreeningRegistry.Screening",
        "components": [
          {
            "name": "subject",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sanctioned",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "screenedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "source",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidence",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "eip712Domain",
    "inputs": [],
    "outputs": [
      {
        "name": "fields",
        "type": "bytes1",
        "internalType": "bytes1"
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "version",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "chainId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "verifyingContract",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "extensions",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isCleared",
    "inputs": [
      {
        "name": "subject",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isScreener",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxAge",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "screeningOf",
    "inputs": [
      {
        "name": "subject",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IScreeningRegistry.Record",
        "components": [
          {
            "name": "screener",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "screenedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "sanctioned",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "source",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidence",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setMaxAge",
    "inputs": [
      {
        "name": "maxAge_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setScreener",
    "inputs": [
      {
        "name": "screener",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "submit",
    "inputs": [
      {
        "name": "screening",
        "type": "tuple",
        "internalType": "struct IScreeningRegistry.Screening",
        "components": [
          {
            "name": "subject",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sanctioned",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "screenedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "source",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidence",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "submitMany",
    "inputs": [
      {
        "name": "screenings",
        "type": "tuple[]",
        "internalType": "struct IScreeningRegistry.Screening[]",
        "components": [
          {
            "name": "subject",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sanctioned",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "screenedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "source",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidence",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "signatures",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "EIP712DomainChanged",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MaxAgeUpdated",
    "inputs": [
      {
        "name": "maxAge",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Screened",
    "inputs": [
      {
        "name": "subject",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sanctioned",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "screenedAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "source",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "evidence",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "screener",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ScreenerUpdated",
    "inputs": [
      {
        "name": "screener",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignatureLength",
    "inputs": [
      {
        "name": "length",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignatureS",
    "inputs": [
      {
        "name": "s",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LengthMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MaxAgeOutOfRange",
    "inputs": [
      {
        "name": "maxAge",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAScreener",
    "inputs": [
      {
        "name": "signer",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotNewerThanRecorded",
    "inputs": [
      {
        "name": "subject",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "screenedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "recorded",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "RenounceDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ScreenedInTheFuture",
    "inputs": [
      {
        "name": "screenedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "blockTimestamp",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ScreeningTooOld",
    "inputs": [
      {
        "name": "screenedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "maxAge",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
